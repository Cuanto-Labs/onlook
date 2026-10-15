import { constants as fsConstants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import { fsError, HttpError } from './errors.js';
import { invalidPath, resolveSafe } from './paths.js';

export const MAX_READ_BYTES = 10 * 1024 * 1024;
const BINARY_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff', '.pdf', '.zip', '.gz',
    '.tar', '.tgz', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov',
    '.webm', '.wav', '.ogg', '.wasm', '.so', '.dylib', '.exe', '.bin', '.sqlite', '.db',
]);

export type FileType = 'file' | 'directory';

export interface StatResult {
    type: FileType;
    isSymlink: boolean;
    size: number;
    mtime: number;
    ctime: number;
    atime: number;
}

const typeOf = (st: Stats): FileType => (st.isDirectory() ? 'directory' : 'file');

async function guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        return fsError(e);
    }
}

export function isBinary(name: string, buf: Buffer): boolean {
    if (BINARY_EXT.has(path.extname(name).toLowerCase())) return true;
    return buf.subarray(0, 8192).includes(0);
}

export const fsStat = (root: string, p: string): Promise<StatResult> =>
    guard(async () => {
        const abs = await resolveSafe(root, p, { followFinal: false });
        const l = await fs.lstat(abs);
        let st: Stats = l;
        if (l.isSymbolicLink()) {
            try {
                st = await fs.stat(abs);
            } catch {
                st = l; // dangling link
            }
        }
        return {
            type: typeOf(st),
            isSymlink: l.isSymbolicLink(),
            size: st.size,
            mtime: Math.floor(st.mtimeMs),
            ctime: Math.floor(st.ctimeMs),
            atime: Math.floor(st.atimeMs),
        };
    });

export const fsList = (
    root: string,
    p: string,
): Promise<{ files: { name: string; type: FileType; isSymlink: boolean }[] }> =>
    guard(async () => {
        const abs = await resolveSafe(root, p);
        const entries = await fs.readdir(abs, { withFileTypes: true });
        const files = await Promise.all(
            entries.map(async (d) => {
                let type: FileType = d.isDirectory() ? 'directory' : 'file';
                if (d.isSymbolicLink()) {
                    try {
                        type = typeOf(await fs.stat(path.join(abs, d.name)));
                    } catch {
                        type = 'file';
                    }
                }
                return { name: d.name, type, isSymlink: d.isSymbolicLink() };
            }),
        );
        return { files };
    });

export const fsRead = (
    root: string,
    p: string,
): Promise<{ type: 'text' | 'binary'; content: string }> =>
    guard(async () => {
        const abs = await resolveSafe(root, p);
        // O_NONBLOCK: opening a FIFO planted by the sandbox must not hang the worker.
        const fh = await fs.open(abs, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        try {
            const st = await fh.stat();
            if (st.isDirectory() || !st.isFile()) throw invalidPath();
            if (st.size > MAX_READ_BYTES) throw new HttpError(413, 'file too large');
            const buf = Buffer.alloc(st.size);
            let off = 0;
            while (off < buf.length) {
                const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
                if (bytesRead === 0) break;
                off += bytesRead;
            }
            const data = off === buf.length ? buf : buf.subarray(0, off);
            return isBinary(abs, data)
                ? { type: 'binary', content: data.toString('base64') }
                : { type: 'text', content: data.toString('utf8') };
        } finally {
            await fh.close();
        }
    });

export const fsWrite = (
    root: string,
    p: string,
    content: string,
    encoding: 'utf8' | 'base64',
    overwrite = true,
): Promise<void> =>
    guard(async () => {
        const abs = await resolveSafe(root, p);
        if (abs === (await fs.realpath(root))) throw invalidPath();
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const data = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
        await fs.writeFile(abs, data, { flag: overwrite ? 'w' : 'wx' });
    });

export const fsRename = (root: string, oldPath: string, newPath: string): Promise<void> =>
    guard(async () => {
        const from = await resolveSafe(root, oldPath, { followFinal: false });
        const to = await resolveSafe(root, newPath, { followFinal: false });
        const realRoot = await fs.realpath(root);
        if (from === realRoot || to === realRoot) throw invalidPath();
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
    });

export const fsCopy = (
    root: string,
    sourcePath: string,
    targetPath: string,
    recursive = false,
    overwrite = false,
): Promise<void> =>
    guard(async () => {
        const from = await resolveSafe(root, sourcePath);
        const to = await resolveSafe(root, targetPath, { followFinal: false });
        const st = await fs.stat(from);
        if (st.isDirectory() && !recursive) throw new HttpError(400, 'source is a directory; set recursive');
        if (!overwrite) {
            try {
                await fs.lstat(to);
                throw new HttpError(409, 'already exists');
            } catch (e) {
                if (e instanceof HttpError) throw e;
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            }
        }
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.cp(from, to, { recursive, force: overwrite, errorOnExist: !overwrite });
    });

export const fsMkdir = (root: string, p: string): Promise<void> =>
    guard(async () => {
        await fs.mkdir(await resolveSafe(root, p), { recursive: true });
    });

export const fsDelete = (root: string, p: string, recursive: boolean): Promise<void> =>
    guard(async () => {
        const abs = await resolveSafe(root, p, { followFinal: false });
        if (abs === (await fs.realpath(root))) throw invalidPath();
        const st = await fs.lstat(abs);
        if (st.isDirectory()) {
            if (recursive) await fs.rm(abs, { recursive: true, force: true });
            else await fs.rmdir(abs);
        } else {
            await fs.unlink(abs);
        }
    });

const SKIP_DOWNLOAD = new Set(['node_modules', '.next']);

/** gzip tar of `p` (relative to the project root), skipping node_modules and .next. */
export async function fsDownload(root: string, p: string): Promise<Readable> {
    return guard(async () => {
        const abs = await resolveSafe(root, p);
        const st = await fs.stat(abs);
        const cwd = st.isDirectory() ? abs : path.dirname(abs);
        const entry = st.isDirectory() ? '.' : path.basename(abs);
        const pack = tar.c(
            {
                gzip: true,
                cwd,
                portable: true,
                filter: (entryPath) => !entryPath.split('/').some((seg) => SKIP_DOWNLOAD.has(seg)),
            },
            [entry],
        );
        // tar's Pack is a minipass stream, not a Node Readable; adapt via async iteration
        return Readable.from(pack as AsyncIterable<Buffer>, { objectMode: false });
    });
}

/** Delete everything inside the project dir (not the dir itself). Runs as the sandbox uid inside the worker. */
export const fsPurge = (root: string): Promise<void> =>
    guard(async () => {
        for (const name of await fs.readdir(root)) {
            await fs.rm(path.join(root, name), { recursive: true, force: true });
        }
    });
