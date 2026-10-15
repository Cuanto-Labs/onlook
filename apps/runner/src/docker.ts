import Docker from 'dockerode';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { Writable } from 'node:stream';
import * as tar from 'tar';
import type { Config } from './config.js';
import { HttpError } from './errors.js';
import { createOutputCapture, wrapShell } from './exec.js';
import type {
    ContainerRuntime,
    ExecResult,
    LogFollow,
    OpenStreamOptions,
    StreamHandle,
} from './runtime.js';

export const LABEL = 'onlook.sbx';
export const containerName = (id: string) => `onlook-sbx-${id}`;
const TMP_LABEL = 'onlook.tmp';
const NOFILE = 4096;
const READY_TIMEOUT_MS = 90_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Utf8 decoding sink that survives multi-byte chars split across chunks. */
function decodingSink(onData: (s: string) => void): Writable {
    const dec = new StringDecoder('utf8');
    return new Writable({
        write(chunk: Buffer, _enc, cb) {
            const s = dec.write(chunk);
            if (s) onData(s);
            cb();
        },
        final(cb) {
            const s = dec.end();
            if (s) onData(s);
            cb();
        },
    });
}

/** Wait for any HTTP response on 127.0.0.1:port. */
export async function waitForHttp(
    port: number,
    timeoutMs: number,
    alive: () => Promise<boolean>,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await fetch(`http://127.0.0.1:${port}/`, {
                redirect: 'manual',
                signal: AbortSignal.timeout(10_000),
            });
            return;
        } catch {
            // not listening yet
        }
        if (!(await alive())) throw new HttpError(500, 'sandbox container exited during startup');
        await sleep(500);
    }
    throw new HttpError(500, `sandbox did not answer on port ${port} within ${timeoutMs / 1000}s`);
}

export class DockerRuntime implements ContainerRuntime {
    readonly docker: Docker;

    constructor(
        private readonly cfg: Config,
        socketPath = '/var/run/docker.sock',
    ) {
        this.docker = new Docker({ socketPath });
    }

    /**
     * Create the dedicated sandbox bridge network if missing. icc is disabled so sandboxes cannot reach each
     * other (or anything else on the bridge) container-to-container; published ports on 127.0.0.1 still work.
     */
    async ensureNetwork(): Promise<void> {
        const name = this.cfg.sandboxNetwork;
        const existing = await this.docker.listNetworks({ filters: { name: [name] } });
        if (existing.some((n) => n.Name === name)) return;
        try {
            await this.docker.createNetwork({
                Name: name,
                Driver: 'bridge',
                CheckDuplicate: true,
                Options: { 'com.docker.network.bridge.enable_icc': 'false' },
                Labels: { 'onlook.net': '1' },
            });
        } catch (e) {
            if ((e as { statusCode?: number }).statusCode === 409) return; // created concurrently
            throw e;
        }
    }

    /** Remove half-finished template-copy containers left behind by a runner crash. */
    async sweepTmpContainers(): Promise<number> {
        const list = await this.docker.listContainers({ all: true, filters: { label: [TMP_LABEL] } });
        for (const c of list) await this.docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined);
        return list.length;
    }

    async init(): Promise<void> {
        await this.ensureNetwork();
        const n = await this.sweepTmpContainers();
        if (n) console.log(`[runner] removed ${n} leftover ${TMP_LABEL} container(s)`);
    }

    private c(id: string) {
        return this.docker.getContainer(containerName(id));
    }

    private async inspect(id: string) {
        try {
            return await this.c(id).inspect();
        } catch (e) {
            if ((e as { statusCode?: number }).statusCode === 404) return null;
            throw e;
        }
    }

    async runningIds(): Promise<Set<string>> {
        const list = await this.docker.listContainers({
            filters: { label: [LABEL], status: ['running'] },
        });
        const ids = new Set<string>();
        for (const c of list) {
            const id = c.Labels?.[LABEL];
            if (id) ids.add(id);
        }
        return ids;
    }

    async isRunning(id: string): Promise<boolean> {
        return (await this.inspect(id))?.State.Running ?? false;
    }

    async start(id: string, port: number, identity: { uid: number; gid: number }): Promise<void> {
        const info = await this.inspect(id);
        if (info?.State.Running) return;
        if (info) await this.c(id).remove({ force: true }); // recreate so current limits/image apply
        await this.ensureNetwork();
        const cfg = this.cfg;
        const container = await this.docker.createContainer({
            name: containerName(id),
            Image: cfg.sandboxImage,
            User: `${identity.uid}:${identity.gid}`,
            WorkingDir: '/app',
            Env: ['HOME=/tmp', 'NEXT_TELEMETRY_DISABLED=1'],
            Labels: { [LABEL]: id },
            ExposedPorts: { '3000/tcp': {} },
            HostConfig: {
                Binds: [`${cfg.projectsDir}/${id}:/app`],
                PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] },
                Memory: cfg.sandboxMemMb * 1024 * 1024,
                MemorySwap: cfg.sandboxMemMb * 1024 * 1024,
                NanoCpus: Math.round(cfg.sandboxCpus * 1e9),
                PidsLimit: 512,
                NetworkMode: cfg.sandboxNetwork,
                Ulimits: [{ Name: 'nofile', Soft: NOFILE, Hard: NOFILE }],
                CapDrop: ['ALL'],
                SecurityOpt: ['no-new-privileges'],
                RestartPolicy: { Name: 'no' },
            },
        });
        try {
            await container.start();
            await waitForHttp(port, READY_TIMEOUT_MS, () => this.isRunning(id));
        } catch (e) {
            await this.stop(id).catch(() => undefined);
            throw e;
        }
    }

    async stop(id: string): Promise<void> {
        try {
            await this.c(id).remove({ force: true, v: false });
        } catch (e) {
            const status = (e as { statusCode?: number }).statusCode;
            if (status === 404 || status === 409) return; // gone / removal already in progress
            throw e;
        }
    }

    async exec(id: string, command: string, timeoutMs: number): Promise<ExecResult> {
        // Keep draining after the cap (so the process finishes and reports a real exit code) but drop the data.
        const capture = createOutputCapture();
        const handle = await this.openStream(
            id,
            { cmd: wrapShell(command, timeoutMs), tty: false, stdin: false },
            (s) => capture.push(s),
        );
        const hard = setTimeout(() => handle.close(), timeoutMs + 10_000);
        try {
            const exitCode = await handle.done;
            return { output: capture.result(), exitCode };
        } finally {
            clearTimeout(hard);
        }
    }

    async openStream(
        id: string,
        opts: OpenStreamOptions,
        onData: (chunk: string) => void,
    ): Promise<StreamHandle> {
        const container = this.c(id);
        const exec = await container.exec({
            Cmd: opts.cmd,
            AttachStdout: true,
            AttachStderr: true,
            AttachStdin: opts.stdin,
            Tty: opts.tty,
            // no User: the exec runs as the container's own per-sandbox uid:gid
            WorkingDir: '/app',
            Env: ['TERM=xterm-256color', 'HOME=/tmp', 'NEXT_TELEMETRY_DISABLED=1'],
        });
        const stream = await exec.start({ hijack: opts.stdin, stdin: opts.stdin, Tty: opts.tty });
        const sink = decodingSink(onData);
        if (opts.tty) stream.pipe(sink);
        else this.docker.modem.demuxStream(stream, sink, sink); // merged stdout+stderr

        const done = new Promise<number>((resolve) => {
            let finished = false;
            const finish = async () => {
                if (finished) return;
                finished = true;
                for (let i = 0; i < 20; i++) {
                    const info = await exec.inspect().catch(() => null);
                    if (info && !info.Running && info.ExitCode !== null && info.ExitCode !== undefined) {
                        return resolve(info.ExitCode);
                    }
                    await sleep(50);
                }
                resolve(-1);
            };
            stream.on('end', finish);
            stream.on('close', finish);
            stream.on('error', finish);
        });

        const handle: StreamHandle = {
            write: (data) => {
                if (opts.stdin) stream.write(data);
            },
            resize: async (cols, rows) => {
                if (opts.tty) await exec.resize({ w: cols, h: rows }).catch(() => undefined);
            },
            close: () => stream.destroy(),
            pause: () => stream.pause(),
            resume: () => stream.resume(),
            done,
        };
        if (opts.tty && opts.cols && opts.rows) await handle.resize(opts.cols, opts.rows);
        return handle;
    }

    async followLogs(id: string, tail: number, onData: (chunk: string) => void): Promise<LogFollow> {
        const container = this.c(id);
        const stream = (await container.logs({
            follow: true,
            stdout: true,
            stderr: true,
            tail,
        })) as unknown as NodeJS.ReadableStream & { destroy(): void };
        const sink = decodingSink(onData);
        this.docker.modem.demuxStream(stream, sink, sink);
        const ended = new Promise<void>((resolve) => {
            stream.on('end', resolve);
            stream.on('close', resolve);
            stream.on('error', () => resolve());
        });
        return {
            close: () => stream.destroy(),
            pause: () => stream.pause(),
            resume: () => stream.resume(),
            ended,
        };
    }

    async restart(id: string): Promise<void> {
        await this.c(id).restart({ t: 5 });
    }

    async copyTemplate(destDir: string): Promise<void> {
        const tmp = await this.docker.createContainer({
            Image: this.cfg.sandboxImage,
            Cmd: ['true'],
            Labels: { [TMP_LABEL]: '1' },
            NetworkDisabled: true,
        });
        try {
            const archive = await tmp.getArchive({ path: '/template' });
            await pipeline(archive, tar.x({ cwd: destDir, strip: 1 }));
        } finally {
            await tmp.remove({ force: true }).catch(() => undefined);
        }
    }

    async removeOrphans(known: Set<string>): Promise<string[]> {
        const list = await this.docker.listContainers({ all: true, filters: { label: [LABEL] } });
        const removed: string[] = [];
        for (const c of list) {
            const id = c.Labels?.[LABEL];
            if (id && !known.has(id)) {
                await this.docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined);
                removed.push(id);
            }
        }
        return removed;
    }
}
