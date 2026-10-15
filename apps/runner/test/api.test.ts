import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { setup } from './helpers.js';

async function newSandbox(t: ReturnType<typeof setup>) {
    const res = await t.call('POST', '/sandboxes', t.admin, {});
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; port: number };
}

describe('auth + health', () => {
    test('/health needs no auth', async () => {
        const t = setup();
        const res = await t.call('GET', '/health', null);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('ok');
    });

    test('401 without / with bad / with expired token', async () => {
        const t = setup();
        const { id } = await newSandbox(t);
        for (const [m, u] of [
            ['GET', '/sandboxes'],
            ['POST', '/sandboxes'],
            ['GET', `/sandboxes/${id}/fs/list?path=`],
            ['POST', `/sandboxes/${id}/start`],
            ['DELETE', `/sandboxes/${id}`],
        ] as const) {
            const res = await t.call(m, u, null, m === 'POST' ? {} : undefined);
            expect(res.status).toBe(401);
            expect(await res.json()).toEqual({ error: 'unauthorized' });
        }
        expect((await t.call('GET', '/sandboxes', 'abc.def')).status).toBe(401);
    });

    test('per-sandbox token: ok on own routes, 403 on others and on admin routes', async () => {
        const t = setup();
        const a = await newSandbox(t);
        const b = await newSandbox(t);
        const tok = t.tokenFor(a.id);
        expect((await t.call('GET', `/sandboxes/${a.id}/fs/list?path=`, tok)).status).toBe(200);
        expect((await t.call('GET', `/sandboxes/${b.id}/fs/list?path=`, tok)).status).toBe(403);
        expect((await t.call('GET', '/sandboxes', tok)).status).toBe(403);
        expect((await t.call('POST', '/sandboxes', tok, {})).status).toBe(403);
        expect((await t.call('DELETE', `/sandboxes/${a.id}`, tok)).status).toBe(403);
        expect((await t.call('GET', `/sandboxes/${b.id}/fs/list?path=`, t.admin)).status).toBe(200);
    });

    test('unknown sandbox -> 404', async () => {
        const t = setup();
        const res = await t.call('GET', '/sandboxes/dk4901-aaaaaa/fs/list?path=', t.admin);
        expect(res.status).toBe(404);
        expect((await t.call('DELETE', '/sandboxes/dk4901-aaaaaa', t.admin)).status).toBe(404);
    });
});

describe('sandbox lifecycle (Docker mocked)', () => {
    test('create from template, list, start, stop, delete', async () => {
        const t = setup();
        const { id, port } = await newSandbox(t);
        expect(id).toMatch(/^dk\d{4,5}-[a-z0-9]{6}$/);
        expect(port).toBe(4900);
        expect(fs.existsSync(path.join(t.dir, id, 'package.json'))).toBe(true);

        let list = (await (await t.call('GET', '/sandboxes', t.admin)).json()) as any;
        expect(list.sandboxes).toHaveLength(1);
        expect(list.sandboxes[0]).toMatchObject({ id, port, running: false });
        expect(new Date(list.sandboxes[0].lastActive).toString()).not.toBe('Invalid Date');

        const start = await t.call('POST', `/sandboxes/${id}/start`, t.tokenFor(id));
        expect(await start.json()).toEqual({ id, port, running: true });
        list = (await (await t.call('GET', '/sandboxes', t.admin)).json()) as any;
        expect(list.sandboxes[0].running).toBe(true);

        expect((await t.call('POST', `/sandboxes/${id}/ping`, t.tokenFor(id))).status).toBe(200);
        expect(await (await t.call('POST', `/sandboxes/${id}/stop`, t.tokenFor(id))).json()).toEqual({});
        expect(t.runtime.running.has(id)).toBe(false);

        expect(await (await t.call('DELETE', `/sandboxes/${id}`, t.admin)).json()).toEqual({});
        expect(fs.existsSync(path.join(t.dir, id))).toBe(false);
        expect(t.registry.get(id)).toBeUndefined();
    });

    test('fromId copies the project dir without .next', async () => {
        const t = setup();
        const a = await newSandbox(t);
        fs.mkdirSync(path.join(t.dir, a.id, '.next'));
        fs.writeFileSync(path.join(t.dir, a.id, '.next', 'cache'), 'x');
        fs.writeFileSync(path.join(t.dir, a.id, 'src', 'page.tsx'), 'hello');
        const res = await t.call('POST', '/sandboxes', t.admin, { fromId: a.id, title: 'copy' });
        const b = (await res.json()) as { id: string; port: number };
        expect(b.id).not.toBe(a.id);
        expect(b.port).toBe(4901);
        expect(fs.readFileSync(path.join(t.dir, b.id, 'src', 'page.tsx'), 'utf8')).toBe('hello');
        expect(fs.existsSync(path.join(t.dir, b.id, '.next'))).toBe(false);
        expect((await t.call('POST', '/sandboxes', t.admin, { fromId: 'dk4999-zzzzzz' })).status).toBe(404);
        expect((await t.call('POST', '/sandboxes', t.admin, { fromId: '../etc' })).status).toBe(400);
    });

    test('503 when no port free', async () => {
        const t = setup({ PORT_MIN: '4900', PORT_MAX: '4901' });
        await newSandbox(t);
        await newSandbox(t);
        const res = await t.call('POST', '/sandboxes', t.admin, {});
        expect(res.status).toBe(503);
        expect(fs.readdirSync(t.dir).filter((n) => n.startsWith('dk'))).toHaveLength(2);
    });

    test('start evicts the least recently active sandbox beyond MAX_RUNNING', async () => {
        const t = setup({ MAX_RUNNING: '2' });
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) ids.push((await newSandbox(t)).id);
        t.registry.touch(ids[0]!, 1000);
        t.registry.touch(ids[1]!, 2000);
        t.runtime.running.add(ids[0]!);
        t.runtime.running.add(ids[1]!);
        await t.call('POST', `/sandboxes/${ids[2]}/start`, t.admin);
        expect(t.runtime.running.has(ids[0]!)).toBe(false);
        expect(t.runtime.running.has(ids[1]!)).toBe(true);
        expect(t.runtime.running.has(ids[2]!)).toBe(true);
    });

    test('idle reaper stops only idle sandboxes', async () => {
        const t = setup({ IDLE_MINUTES: '30' });
        const a = await newSandbox(t);
        const b = await newSandbox(t);
        t.runtime.running.add(a.id);
        t.runtime.running.add(b.id);
        const now = Date.now();
        t.registry.touch(a.id, now - 31 * 60_000);
        t.registry.touch(b.id, now - 5 * 60_000);
        expect(await t.deps.service.reapIdle(now)).toEqual([a.id]);
        expect(t.runtime.running.has(b.id)).toBe(true);
    });

    test('exec: 409 when stopped, runs when running, git-status parses porcelain', async () => {
        const t = setup();
        const { id } = await newSandbox(t);
        expect((await t.call('POST', `/sandboxes/${id}/exec`, t.admin, { command: 'ls' })).status).toBe(409);
        t.runtime.running.add(id);
        t.runtime.execResult = { output: 'hi\n', exitCode: 0 };
        const res = await t.call('POST', `/sandboxes/${id}/exec`, t.admin, { command: 'echo hi' });
        expect(await res.json()).toEqual({ output: 'hi\n', exitCode: 0 });
        expect((await t.call('POST', `/sandboxes/${id}/exec`, t.admin, { command: '' })).status).toBe(400);
        t.runtime.execResult = { output: ' M src/a.ts\0?? new file.txt\0R  b.ts\0a.ts\0', exitCode: 0 };
        const gs = await t.call('GET', `/sandboxes/${id}/git-status`, t.admin);
        expect(await gs.json()).toEqual({ changedFiles: ['src/a.ts', 'new file.txt', 'b.ts'] });
    });

    test('CORS preflight is not blocked by auth', async () => {
        const t = setup();
        const res = await t.app.request('/sandboxes/dk4901-aaaaaa/fs/list', {
            method: 'OPTIONS',
            headers: { origin: 'https://x', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
});

describe('fs routes round trip', () => {
    test('write/read/stat/list/mkdir/rename/copy/delete', async () => {
        const t = setup();
        const { id } = await newSandbox(t);
        const tok = t.tokenFor(id);
        const u = (p: string, q = '') => `/sandboxes/${id}/${p}${q}`;
        const j = async (r: Response) => (await r.json()) as any;

        // write (creates parents) + read text
        let r = await t.call('PUT', u('fs/write'), tok, { path: '/project/workspace/src/app/hello.txt', content: 'héllo', encoding: 'utf8' });
        expect(await j(r)).toEqual({ success: true });
        expect(fs.readFileSync(path.join(t.dir, id, 'src/app/hello.txt'), 'utf8')).toBe('héllo');
        r = await t.call('GET', u('fs/read', '?path=src/app/hello.txt'), tok);
        expect(await j(r)).toEqual({ type: 'text', content: 'héllo' });

        // overwrite=false -> 409; default overwrite works
        r = await t.call('PUT', u('fs/write'), tok, { path: 'src/app/hello.txt', content: 'x', encoding: 'utf8', overwrite: false });
        expect(r.status).toBe(409);
        r = await t.call('PUT', u('fs/write'), tok, { path: 'src/app/hello.txt', content: 'v2', encoding: 'utf8' });
        expect(r.status).toBe(200);

        // binary via base64 (NUL byte) and by extension
        const bin = Buffer.from([1, 2, 0, 3]);
        await t.call('PUT', u('fs/write'), tok, { path: 'data.bin2', content: bin.toString('base64'), encoding: 'base64' });
        r = await t.call('GET', u('fs/read', '?path=data.bin2'), tok);
        expect(await j(r)).toEqual({ type: 'binary', content: bin.toString('base64') });
        await t.call('PUT', u('fs/write'), tok, { path: 'pic.png', content: 'plain', encoding: 'utf8' });
        expect((await j(await t.call('GET', u('fs/read', '?path=pic.png'), tok))).type).toBe('binary');

        // stat
        const st = await j(await t.call('GET', u('fs/stat', '?path=src/app/hello.txt'), tok));
        expect(st).toMatchObject({ type: 'file', isSymlink: false, size: 2 });
        expect(typeof st.mtime).toBe('number');
        expect((await j(await t.call('GET', u('fs/stat', '?path=src'), tok))).type).toBe('directory');
        expect((await t.call('GET', u('fs/stat', '?path=nope'), tok)).status).toBe(404);

        // list
        const ls = await j(await t.call('GET', u('fs/list', '?path=src'), tok));
        expect(ls.files).toContainEqual({ name: 'app', type: 'directory', isSymlink: false });

        // mkdir idempotent
        expect((await t.call('POST', u('fs/mkdir'), tok, { path: 'a/b/c' })).status).toBe(200);
        expect((await t.call('POST', u('fs/mkdir'), tok, { path: '/a/b/c' })).status).toBe(200);
        expect(fs.statSync(path.join(t.dir, id, 'a/b/c')).isDirectory()).toBe(true);

        // rename
        r = await t.call('POST', u('fs/rename'), tok, { oldPath: 'src/app/hello.txt', newPath: 'moved/hi.txt' });
        expect(await j(r)).toEqual({});
        expect(fs.existsSync(path.join(t.dir, id, 'moved/hi.txt'))).toBe(true);
        expect(fs.existsSync(path.join(t.dir, id, 'src/app/hello.txt'))).toBe(false);

        // copy file, dir needs recursive, existing target needs overwrite
        r = await t.call('POST', u('fs/copy'), tok, { sourcePath: 'moved/hi.txt', targetPath: 'copy/hi.txt' });
        expect(r.status).toBe(200);
        r = await t.call('POST', u('fs/copy'), tok, { sourcePath: 'moved/hi.txt', targetPath: 'copy/hi.txt' });
        expect(r.status).toBe(409);
        r = await t.call('POST', u('fs/copy'), tok, { sourcePath: 'moved/hi.txt', targetPath: 'copy/hi.txt', overwrite: true });
        expect(r.status).toBe(200);
        r = await t.call('POST', u('fs/copy'), tok, { sourcePath: 'moved', targetPath: 'moved2' });
        expect(r.status).toBe(400);
        r = await t.call('POST', u('fs/copy'), tok, { sourcePath: 'moved', targetPath: 'moved2', recursive: true });
        expect(r.status).toBe(200);
        expect(fs.readFileSync(path.join(t.dir, id, 'moved2/hi.txt'), 'utf8')).toBe('v2');

        // download (gzip tar, skips node_modules/.next)
        fs.mkdirSync(path.join(t.dir, id, 'node_modules/x'), { recursive: true });
        fs.writeFileSync(path.join(t.dir, id, 'node_modules/x/i.js'), 'x');
        r = await t.call('GET', u('fs/download', '?path='), tok);
        expect(r.headers.get('content-type')).toBe('application/gzip');
        const tarBuf = gunzipSync(Buffer.from(await r.arrayBuffer())).toString('latin1');
        expect(tarBuf).toContain('moved/hi.txt');
        expect(tarBuf).not.toContain('node_modules/x/i.js');

        // delete: non-recursive dir with content fails, recursive works, file works
        r = await t.call('DELETE', u('fs', '?path=moved&recursive=false'), tok);
        expect(r.status).toBe(409);
        r = await t.call('DELETE', u('fs', '?path=moved&recursive=true'), tok);
        expect(await j(r)).toEqual({});
        expect(fs.existsSync(path.join(t.dir, id, 'moved'))).toBe(false);
        r = await t.call('DELETE', u('fs', '?path=pic.png'), tok);
        expect(r.status).toBe(200);
        expect((await t.call('DELETE', u('fs', '?path=pic.png'), tok)).status).toBe(404);
        expect((await t.call('DELETE', u('fs', '?path=/&recursive=true'), tok)).status).toBe(400);
    });

    test('path escapes are 400 through the API', async () => {
        const t = setup();
        const { id } = await newSandbox(t);
        const tok = t.tokenFor(id);
        const outside = path.join(t.dir, 'outside.txt');
        fs.writeFileSync(outside, 'secret');
        fs.symlinkSync(t.dir, path.join(t.dir, id, 'link'));
        for (const p of ['../outside.txt', 'src/../../outside.txt', 'link/outside.txt']) {
            const r = await t.call('GET', `/sandboxes/${id}/fs/read?path=${encodeURIComponent(p)}`, tok);
            expect(r.status).toBe(400);
            expect(await r.json()).toEqual({ error: 'invalid path' });
        }
        const w = await t.call('PUT', `/sandboxes/${id}/fs/write`, tok, { path: 'link/pwn.txt', content: 'x', encoding: 'utf8' });
        expect(w.status).toBe(400);
        expect(fs.existsSync(path.join(t.dir, 'pwn.txt'))).toBe(false);
        const rn = await t.call('POST', `/sandboxes/${id}/fs/rename`, tok, { oldPath: 'package.json', newPath: '../x.json' });
        expect(rn.status).toBe(400);
        // deleting the link itself is allowed and leaves the target alone
        expect((await t.call('DELETE', `/sandboxes/${id}/fs?path=link`, tok)).status).toBe(200);
        expect(fs.existsSync(outside)).toBe(true);
    });

    test('bad input -> 400', async () => {
        const t = setup();
        const { id } = await newSandbox(t);
        const tok = t.tokenFor(id);
        expect((await t.call('GET', `/sandboxes/${id}/fs/read`, tok)).status).toBe(400);
        expect((await t.call('PUT', `/sandboxes/${id}/fs/write`, tok, { path: 'a' })).status).toBe(400);
        const r = await t.app.request(`/sandboxes/${id}/fs/mkdir`, {
            method: 'POST',
            headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
            body: '{nope',
        });
        expect(r.status).toBe(400);
    });
});
