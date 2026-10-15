import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './errors.js';

const WORKSPACE_PREFIX = '/project/workspace';

export const invalidPath = () => new HttpError(400, 'invalid path');

/** Strip `/project/workspace/`, leading `/` and `./`. Returns a relative path ('' = root). */
export function stripPrefix(p: string): string {
    if (typeof p !== 'string' || p.includes('\0')) throw invalidPath();
    let s = p;
    if (s === WORKSPACE_PREFIX || s.startsWith(`${WORKSPACE_PREFIX}/`)) {
        s = s.slice(WORKSPACE_PREFIX.length);
    }
    for (;;) {
        if (s.startsWith('/')) s = s.slice(1);
        else if (s.startsWith('./')) s = s.slice(2);
        else break;
    }
    return s === '.' ? '' : s;
}

const within = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

/** Real path of the nearest existing ancestor (or the path itself). Dangling symlinks are rejected. */
async function nearestReal(p: string): Promise<string> {
    let cur = p;
    for (;;) {
        try {
            await fs.lstat(cur);
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                const parent = path.dirname(cur);
                if (parent === cur) throw invalidPath();
                cur = parent;
                continue;
            }
            throw e;
        }
        try {
            return await fs.realpath(cur);
        } catch {
            throw invalidPath(); // dangling symlink
        }
    }
}

/**
 * Resolve `p` inside `root`. Rejects `..` escapes and symlink escapes.
 * `followFinal: false` leaves a final symlink unresolved (rename/delete operate on the link itself).
 */
export async function resolveSafe(
    root: string,
    p: string,
    opts: { followFinal?: boolean } = {},
): Promise<string> {
    const realRoot = await fs.realpath(root);
    const abs = path.resolve(realRoot, stripPrefix(p));
    if (!within(realRoot, abs)) throw invalidPath();
    if (abs === realRoot) return abs;
    const probe = opts.followFinal === false ? path.dirname(abs) : abs;
    if (!within(realRoot, await nearestReal(probe))) throw invalidPath();
    return abs;
}

/** Path of `abs` relative to the root, '/'-separated, '' for the root itself. */
export const relTo = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');
