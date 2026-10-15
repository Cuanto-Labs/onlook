import chokidar from 'chokidar';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafe } from './paths.js';

export type WatchEventType = 'add' | 'change' | 'remove';
export interface WatchBatch {
    type: WatchEventType;
    paths: string[];
}

const ALWAYS_IGNORED = new Set(['node_modules', '.next', '.git']);
const BATCH_MS = 100;

/**
 * Watch `p` inside the project `root`; calls `onBatch` with project-root-relative paths,
 * batched for 100 ms. Returns a closer.
 */
export async function startWatch(
    root: string,
    p: string,
    opts: { recursive: boolean; excludes: string[] },
    onBatch: (b: WatchBatch) => void,
): Promise<() => Promise<void>> {
    const realRoot = await fs.realpath(root);
    const target = await resolveSafe(root, p);
    const excludes = opts.excludes.map((e) => e.replace(/^\.?\/+/, '').replace(/\/+$/, '')).filter(Boolean);

    const ignored = (abs: string): boolean => {
        const rel = path.relative(realRoot, abs).split(path.sep).join('/');
        if (!rel) return false;
        const segs = rel.split('/');
        if (segs.some((s) => ALWAYS_IGNORED.has(s))) return true;
        return excludes.some((e) => (e.includes('/') ? rel === e || rel.startsWith(`${e}/`) : segs.includes(e)));
    };

    const watcher = chokidar.watch(target, {
        ignoreInitial: true,
        ignored,
        depth: opts.recursive ? undefined : 0,
        followSymlinks: false,
    });

    let queue: { type: WatchEventType; rel: string }[] = [];
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
        timer = null;
        const events = queue;
        queue = [];
        // group consecutive events of the same type, de-duplicating paths
        let cur: { type: WatchEventType; set: Set<string> } | null = null;
        const out: WatchBatch[] = [];
        for (const ev of events) {
            if (!cur || cur.type !== ev.type) {
                if (cur) out.push({ type: cur.type, paths: [...cur.set] });
                cur = { type: ev.type, set: new Set() };
            }
            cur.set.add(ev.rel);
        }
        if (cur) out.push({ type: cur.type, paths: [...cur.set] });
        for (const b of out) onBatch(b);
    };
    const push = (type: WatchEventType) => (abs: string) => {
        queue.push({ type, rel: path.relative(realRoot, abs).split(path.sep).join('/') });
        timer ??= setTimeout(flush, BATCH_MS);
    };
    watcher
        .on('add', push('add'))
        .on('addDir', push('add'))
        .on('change', push('change'))
        .on('unlink', push('remove'))
        .on('unlinkDir', push('remove'));

    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
    return async () => {
        if (timer) clearTimeout(timer);
        await watcher.close();
    };
}
