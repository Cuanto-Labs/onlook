import Docker from 'dockerode';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { Writable } from 'node:stream';
import * as tar from 'tar';
import type { Config } from './config.js';
import { HttpError } from './errors.js';
import { wrapShell } from './exec.js';
import type {
    ContainerRuntime,
    ExecResult,
    LogFollow,
    OpenStreamOptions,
    StreamHandle,
} from './runtime.js';

export const LABEL = 'onlook.sbx';
export const containerName = (id: string) => `onlook-sbx-${id}`;
const SANDBOX_UID = 1000;
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

/** chown -R 1000:1000 (only meaningful as root, which the runner container is). */
export function chownSandbox(dir: string): Promise<void> {
    if (process.getuid?.() !== 0) return Promise.resolve();
    return new Promise((resolve, reject) =>
        execFile('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_UID}`, dir], (err) => (err ? reject(err) : resolve())),
    );
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

    async start(id: string, port: number): Promise<void> {
        const info = await this.inspect(id);
        if (info?.State.Running) return;
        if (info) await this.c(id).remove({ force: true }); // recreate so current limits/image apply
        const cfg = this.cfg;
        const container = await this.docker.createContainer({
            name: containerName(id),
            Image: cfg.sandboxImage,
            User: `${SANDBOX_UID}:${SANDBOX_UID}`,
            WorkingDir: '/app',
            Labels: { [LABEL]: id },
            ExposedPorts: { '3000/tcp': {} },
            HostConfig: {
                Binds: [`${cfg.projectsDir}/${id}:/app`],
                PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] },
                Memory: cfg.sandboxMemMb * 1024 * 1024,
                MemorySwap: cfg.sandboxMemMb * 1024 * 1024,
                NanoCpus: Math.round(cfg.sandboxCpus * 1e9),
                PidsLimit: 512,
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
        let output = '';
        const handle = await this.openStream(
            id,
            { cmd: wrapShell(command, timeoutMs), tty: false, stdin: false },
            (s) => {
                output += s;
            },
        );
        const hard = setTimeout(() => handle.close(), timeoutMs + 10_000);
        try {
            const exitCode = await handle.done;
            return { output, exitCode };
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
            User: `${SANDBOX_UID}`,
            WorkingDir: '/app',
            Env: ['TERM=xterm-256color', 'NEXT_TELEMETRY_DISABLED=1'],
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
        return { close: () => stream.destroy(), ended };
    }

    async restart(id: string): Promise<void> {
        await this.c(id).restart({ t: 5 });
    }

    async copyTemplate(destDir: string): Promise<void> {
        const tmp = await this.docker.createContainer({
            Image: this.cfg.sandboxImage,
            Cmd: ['true'],
            Labels: { 'onlook.tmp': '1' },
            NetworkDisabled: true,
        });
        try {
            const archive = await tmp.getArchive({ path: '/template' });
            await pipeline(archive, tar.x({ cwd: destDir, strip: 1 }));
        } finally {
            await tmp.remove({ force: true }).catch(() => undefined);
        }
        await chownSandbox(destDir);
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
