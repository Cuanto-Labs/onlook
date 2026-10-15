import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { chownSandbox } from './docker.js';
import { HttpError } from './errors.js';
import { GIT_STATUS_CMD, parsePorcelainZ } from './exec.js';
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

    constructor(
        readonly config: Config,
        readonly registry: Registry,
        readonly runtime: ContainerRuntime,
    ) {}

    dirFor(id: string) {
        return path.join(this.config.projectsDir, id);
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
            await fs.mkdir(dir, { recursive: true });
            if (fromId !== undefined) {
                await copyProjectDir(this.dirFor(fromId), dir);
                await chownSandbox(dir);
            } else {
                await this.runtime.copyTemplate(dir);
            }
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
        await fs.rm(this.dirFor(id), { recursive: true, force: true });
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
                await this.runtime.stop(victim.id);
            }
            await this.runtime.start(id, rec.port);
        })().finally(() => this.starting.delete(id));
        this.starting.set(id, p);
        return p;
    }

    async stop(id: string): Promise<void> {
        this.require(id);
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
                await this.runtime.stop(id);
                stopped.push(id);
            }
        }
        this.registry.flushIfDirty();
        return stopped;
    }
}
