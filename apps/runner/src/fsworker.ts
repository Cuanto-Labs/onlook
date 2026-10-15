/**
 * Per-sandbox filesystem worker. Spawned by fsclient.ts with the sandbox's uid/gid and an empty env,
 * so every project-dir operation runs unprivileged: a symlink swapped in by the sandbox between the
 * path check and the use can only ever reach what that sandbox uid could already touch.
 *
 * Modes (argv): `<root> <expectedUid|->`          long-lived IPC worker
 *               `--tar <root> <expectedUid|-> <path>`  one-shot: gzip tar of <path> to stdout
 */
import { pipeline } from 'node:stream/promises';
import { HttpError } from './errors.js';
import {
    fsCopy,
    fsDelete,
    fsDownload,
    fsList,
    fsMkdir,
    fsPurge,
    fsRead,
    fsRename,
    fsStat,
    fsWrite,
} from './fs.js';
import { startWatch, type WatchBatch } from './watch.js';

export type WorkerOp =
    | 'stat'
    | 'list'
    | 'read'
    | 'write'
    | 'rename'
    | 'copy'
    | 'mkdir'
    | 'delete'
    | 'purge'
    | 'watch'
    | 'unwatch';

export interface WorkerRequest {
    id: number;
    op: WorkerOp;
    args: unknown[];
}

export type WorkerResponse =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; status: number; message: string };

export type WorkerEvent = { evt: 'watch'; wid: number; batch: WatchBatch };

function checkIdentity(expected: string | undefined) {
    if (expected === undefined || expected === '-') return;
    const want = Number(expected);
    if (process.getuid?.() !== want || process.getgid?.() !== want) {
        console.error(`[fsworker] refusing to run: uid/gid ${process.getuid?.()}/${process.getgid?.()} != ${want}`);
        process.exit(3);
    }
}

function describeError(e: unknown): { status: number; message: string } {
    if (e instanceof HttpError) return { status: e.status, message: e.message };
    console.error('[fsworker] unhandled:', e instanceof Error ? e.message : e);
    return { status: 500, message: 'internal error' };
}

async function tarMode(root: string, p: string) {
    try {
        const stream = await fsDownload(root, p);
        await pipeline(stream, process.stdout);
    } catch (e) {
        process.stderr.write(JSON.stringify(describeError(e)));
        process.exit(1);
    }
}

function ipcMode(root: string) {
    const send = (m: WorkerResponse | WorkerEvent) => process.send?.(m);
    const watchers = new Map<number, () => Promise<void>>();
    let nextWid = 1;

    const handlers: Record<WorkerOp, (a: any[]) => Promise<unknown>> = {
        stat: (a) => fsStat(root, a[0]),
        list: (a) => fsList(root, a[0]),
        read: (a) => fsRead(root, a[0]),
        write: (a) => fsWrite(root, a[0], a[1], a[2], a[3]),
        rename: (a) => fsRename(root, a[0], a[1]),
        copy: (a) => fsCopy(root, a[0], a[1], a[2], a[3]),
        mkdir: (a) => fsMkdir(root, a[0]),
        delete: (a) => fsDelete(root, a[0], a[1]),
        purge: () => fsPurge(root),
        watch: async (a) => {
            const wid = nextWid++;
            const close = await startWatch(root, a[0], a[1], (batch) => send({ evt: 'watch', wid, batch }));
            watchers.set(wid, close);
            return { wid };
        },
        unwatch: async (a) => {
            const close = watchers.get(a[0]);
            watchers.delete(a[0]);
            await close?.();
        },
    };

    process.on('message', (raw) => {
        const req = raw as WorkerRequest;
        const h = handlers[req.op];
        if (!h) return send({ id: req.id, ok: false, status: 400, message: 'unknown op' });
        h(Array.isArray(req.args) ? req.args : []).then(
            (result) => send({ id: req.id, ok: true, result: result ?? null }),
            (e) => send({ id: req.id, ok: false, ...describeError(e) }),
        );
    });
    process.on('disconnect', () => process.exit(0));
}

const argv = process.argv.slice(2);
if (argv[0] === '--tar') {
    checkIdentity(argv[2]);
    void tarMode(argv[1] ?? '', argv[3] ?? '');
} else {
    checkIdentity(argv[1]);
    ipcMode(argv[0] ?? '');
}
