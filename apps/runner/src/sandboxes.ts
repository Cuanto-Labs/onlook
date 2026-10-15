import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sandboxIdentity, type Config, type SandboxIdentity } from './config.js';
import { HttpError } from './errors.js';
import { GIT_STATUS_CMD, parsePorcelainZ } from './exec.js';
import { FsClient, type FsClientOptions } from './fsclient.js';
import { isRoot, lockProjectDir } from './perms.js';
import type { ContainerRuntime } from './runtime.js';
import type { Registry, SandboxRecord } from './state.js';

/** `cp -a --reflink=auto` of every top-level entry of `src` except `.next`. */
export async function copyProjectDir(src: string, dest: string): Promise<void> {
    const entries = (await fs.readdir(src)).filter((n) => n !== '.next');
    const flags = process.platform === 'linux' ? ['-a', '--reflink=auto'] : ['-a'];
    for (const name of entries) {
        await new Promise<void>((resolve, reject) =>
            execFile('cp', [...flags, path.join(src, name), dest + path.sep], (err) =>
                err ? reject(err) : resolve(),
            ),
        );
    }
}

export class SandboxService {
    private readonly starting = new Map<string, Promise<void>>();
    private readonly fsClients = new Map<string, FsClient>();

    constructor(
        readonly config: Config,
        readonly registry: Registry,
        readonly runtime: ContainerRuntime,
        private readonly fsOpts: FsClientOptions = {},
    ) {}

    dirFor(id: string) {
        return path.join(this.config.projectsDir, id);
    }

    identityFor(id: string): SandboxIdentity {
        return sandboxIdentity(this.config, this.require(id).port);
    }

    /** All project fs operations go through the sandbox's unprivileged worker, never through the root runner. */
    fsFor(id: string): FsClient {
        let c = this.fsClients.get(id);
        if (!c) {
            c = new FsClient(this.dirFor(id), this.identityFor(id), this.fsOpts);
            this.fsClients.set(id, c);
        }
        return c;
    }

    private killFs(id: string) {
        this.fsClients.get(id)?.kill();
    }

    /** Startup: make sure every project dir is owned by its sandbox uid with mode 0700 (migrates old 1000:1000 dirs). */
    async ensureOwnership(): Promise<void> {
        if (!isRoot()) return;
        for (const rec of this.registry.list()) {
            const dir = this.dirFor(rec.id);
            const st = await fs.lstat(dir).catch(() => null);
            if (!st?.isDirectory()) continue;
            const { uid, gid } = sandboxIdentity(this.config, rec.port);
            if (st.uid !== uid || st.gid !== gid || (st.mode & 0o777) !== 0o700) {
                await lockProjectDir(dir, uid, gid);
                console.log(`[runner] re-owned ${rec.id} to ${uid}:${gid}`);
            }
        }
    }

    require(id: string): SandboxRecord {
        const rec = this.registry.get(id);
        if (!rec) throw new HttpError(404, 'no such sandbox');
        return rec;
    }

    async create(fromId?: string, title?: string): Promise<SandboxRecord> {
        if (fromId !== undefined) this.require(fromId);
        const rec = this.registry.create(title);
        if (!rec) throw new HttpError(503, 'no free port');
        const dir = this.dirFor(rec.id);
        try {
            const { uid, gid } = sandboxIdentity(this.config, rec.port);
            // root-only (0700) while populated, then handed to the sandbox uid
            await fs.mkdir(dir, { recursive: true, mode: 0o700 });
            await fs.chmod(dir, 0o700);
            if (fromId !== undefined) await copyProjectDir(this.dirFor(fromId), dir);
            else await this.runtime.copyTemplate(dir);
            await lockProjectDir(dir, uid, gid);
        } catch (e) {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
            this.registry.remove(rec.id);
            throw e;
        }
        return rec;
    }

    async list() {
        const running = await this.runtime.runningIds();
        return this.registry.list().map((r) => ({
            id: r.id,
            port: r.port,
            running: running.has(r.id),
            lastActive: new Date(r.lastActive).toISOString(),
        }));
    }

    async remove(id: string): Promise<void> {
        this.require(id);
        await this.runtime.stop(id);
        const dir = this.dirFor(id);
        // Empty the dir as the sandbox uid (a hostile symlink swap can't redirect a root rm), then drop it.
        await this.fsFor(id).purge().catch((e) => console.error(`[runner] purge ${id}:`, e instanceof Error ? e.message : e));
        this.fsClients.get(id)?.dispose();
        this.fsClients.delete(id);
        await fs.rm(dir, { recursive: true, force: true });
        this.registry.remove(id);
    }

    /** Start (creating the container if needed), evicting the least recently active sandboxes beyond MAX_RUNNING. */
    start(id: string): Promise<void> {
        const rec = this.require(id);
        const inflight = this.starting.get(id);
        if (inflight) return inflight;
        const p = (async () => {
            this.registry.touch(id);
            if (await this.runtime.isRunning(id)) return;
            const running = [...(await this.runtime.runningIds())].filter((r) => r !== id);
            const byLru = running
                .map((r) => ({ id: r, at: this.registry.get(r)?.lastActive ?? 0 }))
                .sort((a, b) => a.at - b.at);
            while (byLru.length >= this.config.maxRunning) {
                const victim = byLru.shift()!;
                await this.stopContainer(victim.id);
            }
            await this.runtime.start(id, rec.port, sandboxIdentity(this.config, rec.port));
        })().finally(() => this.starting.delete(id));
        this.starting.set(id, p);
        return p;
    }

    async stop(id: string): Promise<void> {
        this.require(id);
        await this.stopContainer(id);
    }

    /** Stop the container and the sandbox's fs worker (respawned lazily on the next fs call). */
    private async stopContainer(id: string): Promise<void> {
        this.killFs(id);
        await this.runtime.stop(id);
    }

    async requireRunning(id: string): Promise<void> {
        this.require(id);
        if (!(await this.runtime.isRunning(id))) throw new HttpError(409, 'sandbox is not running');
    }

    async gitStatus(id: string): Promise<string[]> {
        await this.requireRunning(id);
        const r = await this.runtime.exec(id, GIT_STATUS_CMD, 30_000);
        if (r.exitCode !== 0) return [];
        return parsePorcelainZ(r.output);
    }

    /** Stop running sandboxes idle longer than IDLE_MINUTES. Returns the stopped ids. */
    async reapIdle(now = Date.now()): Promise<string[]> {
        const cutoff = now - this.config.idleMinutes * 60_000;
        const running = await this.runtime.runningIds();
        const stopped: string[] = [];
        for (const id of running) {
            const rec = this.registry.get(id);
            if (rec && rec.lastActive < cutoff) {
                await this.stopContainer(id);
                stopped.push(id);
            }
        }
        this.registry.flushIfDirty();
        return stopped;
    }
}
