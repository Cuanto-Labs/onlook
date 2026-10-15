import { fork, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { HttpError } from './errors.js';
import type { FileType, StatResult } from './fs.js';
import { isRoot } from './perms.js';
import type { WatchBatch } from './watch.js';
import type { WorkerEvent, WorkerOp, WorkerRequest, WorkerResponse } from './fsworker.js';

const WORKER_FILE = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    import.meta.url.endsWith('.ts') ? 'fsworker.ts' : 'fsworker.js',
);

const CALL_TIMEOUT_MS = 5 * 60_000;
const IDLE_KILL_MS = 2 * 60_000;

export interface WorkerIdentity {
    uid: number;
    gid: number;
}

export interface FsClientOptions {
    /** Kill the worker after this long without calls or watches (respawned on demand). */
    idleMs?: number;
    callTimeoutMs?: number;
}

const live = new Set<FsClient>();
process.once('exit', () => {
    for (const c of live) c.kill();
});

interface Pending {
    resolve(v: unknown): void;
    reject(e: unknown): void;
    timer: NodeJS.Timeout;
}

const workerErr = (status: number, message: string) => new HttpError(status as HttpError['status'], message);

/**
 * Talks to one sandbox's fs worker over IPC. The worker is forked lazily with the sandbox uid/gid
 * (when the runner is root), an empty env, and is restarted on demand after a crash or idle kill.
 */
export class FsClient {
    private child: ChildProcess | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private readonly watches = new Map<number, { onBatch(b: WatchBatch): void; onEnd(): void }>();
    private idleTimer: NodeJS.Timeout | null = null;

    constructor(
        readonly root: string,
        readonly identity: WorkerIdentity | null = null,
        private readonly opts: FsClientOptions = {},
    ) {
        live.add(this);
    }

    /** Pid of the running worker, if any (tests). */
    get pid(): number | undefined {
        return this.child?.pid;
    }

    private spawnOptions() {
        const id = isRoot() ? this.identity : null;
        return { id, args: [this.root, id ? String(id.uid) : '-'] };
    }

    private ensure(): ChildProcess {
        if (this.child?.connected) return this.child;
        const { id, args } = this.spawnOptions();
        const child = fork(WORKER_FILE, args, {
            env: {},
            cwd: '/',
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            serialization: 'json',
            ...(id ? { uid: id.uid, gid: id.gid } : {}),
        });
        child.unref();
        (child.channel as { unref?: () => void } | undefined)?.unref?.(); // node only; bun lacks it
        child.on('message', (m) => this.onMessage(m as WorkerResponse | WorkerEvent));
        const gone = () => {
            if (this.child !== child) return;
            this.child = null;
            this.failAll(workerErr(500, 'fs worker exited'));
        };
        child.once('exit', gone);
        child.once('error', gone);
        this.child = child;
        return child;
    }

    private failAll(err: HttpError) {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
        const ended = [...this.watches.values()];
        this.watches.clear();
        for (const w of ended) w.onEnd();
    }

    private onMessage(m: WorkerResponse | WorkerEvent) {
        if ('evt' in m) {
            this.watches.get(m.wid)?.onBatch(m.batch);
            return;
        }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else p.reject(workerErr(m.status, m.message));
        this.armIdle();
    }

    private armIdle() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        if (this.pending.size > 0 || this.watches.size > 0 || !this.child) return;
        this.idleTimer = setTimeout(() => {
            if (this.pending.size === 0 && this.watches.size === 0) this.kill();
        }, this.opts.idleMs ?? IDLE_KILL_MS);
        this.idleTimer.unref();
    }

    private call<T>(op: WorkerOp, ...args: unknown[]): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let child: ChildProcess;
            try {
                child = this.ensure();
            } catch (e) {
                return reject(workerErr(500, `fs worker failed to start: ${e instanceof Error ? e.message : e}`));
            }
            if (this.idleTimer) clearTimeout(this.idleTimer);
            const id = this.nextId++;
            const timer = setTimeout(() => {
                // a wedged worker (e.g. blocked on a FIFO) must not hold the sandbox hostage
                this.kill(workerErr(500, 'fs operation timed out'));
            }, this.opts.callTimeoutMs ?? CALL_TIMEOUT_MS);
            timer.unref();
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
            const req: WorkerRequest = { id, op, args };
            child.send(req, (err) => {
                if (err && this.pending.delete(id)) {
                    clearTimeout(timer);
                    reject(workerErr(500, 'fs worker unavailable'));
                }
            });
        });
    }

    /** Kill the worker; pending calls and watches fail. The next call respawns it. */
    kill(reason: HttpError = workerErr(500, 'fs worker stopped')) {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        const child = this.child;
        this.child = null;
        child?.kill('SIGKILL');
        this.failAll(reason);
    }

    /** Kill and forget (sandbox deleted). */
    dispose() {
        this.kill();
        live.delete(this);
    }

    stat = (p: string) => this.call<StatResult>('stat', p);
    list = (p: string) => this.call<{ files: { name: string; type: FileType; isSymlink: boolean }[] }>('list', p);
    read = (p: string) => this.call<{ type: 'text' | 'binary'; content: string }>('read', p);
    write = (p: string, content: string, encoding: 'utf8' | 'base64', overwrite = true) =>
        this.call<null>('write', p, content, encoding, overwrite).then(() => undefined);
    rename = (from: string, to: string) => this.call<null>('rename', from, to).then(() => undefined);
    copy = (from: string, to: string, recursive = false, overwrite = false) =>
        this.call<null>('copy', from, to, recursive, overwrite).then(() => undefined);
    mkdir = (p: string) => this.call<null>('mkdir', p).then(() => undefined);
    delete = (p: string, recursive: boolean) => this.call<null>('delete', p, recursive).then(() => undefined);
    /** Remove everything inside the project dir (as the sandbox uid). */
    purge = () => this.call<null>('purge').then(() => undefined);

    /** Start a recursive/flat watch inside the worker. `onEnd` fires if the worker dies. Returns the closer. */
    async watch(
        p: string,
        opts: { recursive: boolean; excludes: string[] },
        onBatch: (b: WatchBatch) => void,
        onEnd: () => void,
    ): Promise<() => Promise<void>> {
        const { wid } = await this.call<{ wid: number }>('watch', p, opts);
        this.watches.set(wid, { onBatch, onEnd });
        return async () => {
            if (!this.watches.delete(wid)) return;
            await this.call<null>('unwatch', wid).catch(() => undefined);
            this.armIdle();
        };
    }

    /** gzip tar of `p` (skips node_modules/.next), produced by a one-shot unprivileged child. */
    download(p: string): Promise<Readable> {
        const { id, args } = this.spawnOptions();
        const child = spawn(process.execPath, [WORKER_FILE, '--tar', args[0]!, args[1]!, p], {
            env: {},
            cwd: '/',
            stdio: ['ignore', 'pipe', 'pipe'],
            ...(id ? { uid: id.uid, gid: id.gid } : {}),
        });
        const out = child.stdout!;
        let errText = '';
        child.stderr!.on('data', (c: Buffer) => {
            if (errText.length < 4096) errText += c.toString('utf8');
        });
        return new Promise<Readable>((resolve, reject) => {
            let settled = false;
            const fail = () => {
                let status = 500;
                let message = 'download failed';
                try {
                    const j = JSON.parse(errText) as { status?: number; message?: string };
                    if (typeof j.status === 'number' && typeof j.message === 'string') {
                        status = j.status;
                        message = j.message;
                    }
                } catch {
                    // keep generic error
                }
                return workerErr(status, message);
            };
            const onReadable = () => {
                if (settled || out.readableLength === 0) return;
                settled = true;
                out.removeListener('readable', onReadable);
                resolve(out);
            };
            out.on('readable', onReadable);
            child.once('error', () => {
                if (!settled) {
                    settled = true;
                    reject(workerErr(500, 'download failed'));
                }
            });
            child.once('close', (code) => {
                if (!settled) {
                    settled = true;
                    reject(fail());
                } else if (code !== 0) {
                    out.destroy(new Error('tar failed'));
                }
            });
            out.once('close', () => child.kill('SIGKILL')); // client went away
        });
    }
}
