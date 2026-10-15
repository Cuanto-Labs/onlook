import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { loadConfig, sandboxIdentity } from '../src/config.js';
import { DockerRuntime } from '../src/docker.js';
import { HttpError } from '../src/errors.js';
import { createOutputCapture, MAX_EXEC_OUTPUT_BYTES, TRUNCATION_NOTE } from '../src/exec.js';
import { FsClient } from '../src/fsclient.js';
import { MAX_READ_BYTES } from '../src/fs.js';
import { validRecord, Registry } from '../src/state.js';
import { attachWebSocket } from '../src/ws.js';
import { Flow } from '../src/wsutil.js';
import { SECRET, setup, tmpDir } from './helpers.js';

const status = async (p: Promise<unknown>) => {
    try {
        await p;
        return 200;
    } catch (e) {
        return e instanceof HttpError ? e.status : -1;
    }
};

describe('per-sandbox uid mapping', () => {
    test('uid = base + (port - PORT_MIN), gid equal, config-driven', () => {
        const cfg = loadConfig({ RUNNER_SECRET: SECRET });
        expect(cfg.uidBase).toBe(61000);
        expect(sandboxIdentity(cfg, 4900)).toEqual({ uid: 61000, gid: 61000 });
        expect(sandboxIdentity(cfg, 4919)).toEqual({ uid: 61019, gid: 61019 });
        const c2 = loadConfig({ RUNNER_SECRET: SECRET, SANDBOX_UID_BASE: '70000', PORT_MIN: '5000', PORT_MAX: '5010' });
        expect(sandboxIdentity(c2, 5003)).toEqual({ uid: 70003, gid: 70003 });
        expect(() => sandboxIdentity(c2, 4999)).toThrow('outside');
        expect(() => sandboxIdentity(c2, 5011)).toThrow('outside');
        expect(() => loadConfig({ RUNNER_SECRET: SECRET, SANDBOX_UID_BASE: '10' })).toThrow('SANDBOX_UID_BASE');
    });

    test('distinct sandboxes get distinct identities; start passes the identity to the runtime', async () => {
        const t = setup();
        const a = (await (await t.call('POST', '/sandboxes', t.admin, {})).json()) as { id: string; port: number };
        const b = (await (await t.call('POST', '/sandboxes', t.admin, {})).json()) as { id: string; port: number };
        expect(t.deps.service.identityFor(a.id)).toEqual({ uid: 61000, gid: 61000 });
        expect(t.deps.service.identityFor(b.id)).toEqual({ uid: 61001, gid: 61001 });
        await t.call('POST', `/sandboxes/${b.id}/start`, t.tokenFor(b.id));
        expect(t.runtime.startIdentities).toEqual([{ uid: 61001, gid: 61001 }]);
    });

    test('project dir is 0700, projects root 0711, state file 0600', async () => {
        const t = setup();
        const { id } = (await (await t.call('POST', '/sandboxes', t.admin, {})).json()) as { id: string };
        expect(fs.statSync(path.join(t.dir, id)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(t.dir).mode & 0o777).toBe(0o711);
        expect(fs.statSync(path.join(t.dir, '.state.json')).mode & 0o777).toBe(0o600);
    });
});

describe('fs worker', () => {
    function client(opts = {}) {
        const root = tmpDir('runner-fsw-');
        return { root, c: new FsClient(root, { uid: 61000, gid: 61000 }, opts) };
    }

    test('round trip through the worker process (not in-process)', async () => {
        const { root, c } = client();
        await c.write('/project/workspace/src/a.txt', 'héllo', 'utf8');
        expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('héllo');
        expect(await c.read('src/a.txt')).toEqual({ type: 'text', content: 'héllo' });
        expect((await c.stat('src/a.txt')).size).toBe(6);
        expect((await c.list('src')).files).toEqual([{ name: 'a.txt', type: 'file', isSymlink: false }]);
        await c.mkdir('x/y');
        await c.copy('src/a.txt', 'x/y/b.txt');
        await c.rename('x/y/b.txt', 'x/c.txt');
        expect(fs.existsSync(path.join(root, 'x/c.txt'))).toBe(true);
        expect(await status(c.write('src/a.txt', 'z', 'utf8', false))).toBe(409);
        expect(await status(c.read('missing'))).toBe(404);
        await c.delete('x', true);
        expect(fs.existsSync(path.join(root, 'x'))).toBe(false);
        expect(c.pid).toBeGreaterThan(0);
        expect(c.pid).not.toBe(process.pid);
        c.dispose();
    });

    test('path validation is enforced inside the worker', async () => {
        const { root, c } = client();
        fs.symlinkSync('/etc', path.join(root, 'etc-link'));
        for (const p of ['../x', 'etc-link/passwd', '/project/workspace/../x']) {
            expect(await status(c.read(p))).toBe(400);
        }
        expect(await status(c.write('etc-link/pwn', 'x', 'utf8'))).toBe(400);
        c.dispose();
    });

    test('read over 10 MB -> 413', async () => {
        const { root, c } = client();
        const big = path.join(root, 'big.txt');
        fs.writeFileSync(big, '');
        fs.truncateSync(big, MAX_READ_BYTES + 1);
        expect(await status(c.read('big.txt'))).toBe(413);
        fs.truncateSync(big, MAX_READ_BYTES);
        expect(await status(c.read('big.txt'))).toBe(200);
        c.dispose();
    });

    test('restarts after a crash and after an explicit kill', async () => {
        const { c } = client();
        await c.mkdir('a');
        const first = c.pid!;
        process.kill(first, 'SIGKILL');
        await new Promise((r) => setTimeout(r, 100));
        await c.mkdir('b'); // lazily respawned
        expect(c.pid).toBeDefined();
        expect(c.pid).not.toBe(first);
        const second = c.pid!;
        c.kill();
        expect(c.pid).toBeUndefined();
        await c.mkdir('c');
        expect(c.pid).not.toBe(second);
        c.dispose();
    });

    test('in-flight call fails when the worker dies; idle worker exits on its own', async () => {
        const { root, c } = client({ idleMs: 150 });
        await c.mkdir('a');
        const pid = c.pid!;
        await new Promise((r) => setTimeout(r, 600));
        expect(c.pid).toBeUndefined();
        expect(() => process.kill(pid, 0)).toThrow();
        const slow = c.write('big', Buffer.alloc(20 * 1024 * 1024, 1).toString('base64'), 'base64');
        c.kill();
        expect(await status(slow)).toBe(500);
        expect(fs.existsSync(root)).toBe(true);
        c.dispose();
    });

    test('purge empties the dir; download streams a tar without node_modules and maps errors', async () => {
        const { root, c } = client();
        await c.write('src/a.txt', 'one', 'utf8');
        fs.mkdirSync(path.join(root, 'node_modules/x'), { recursive: true });
        fs.writeFileSync(path.join(root, 'node_modules/x/i.js'), 'x');
        const stream = await c.download('');
        const chunks: Buffer[] = [];
        for await (const ch of stream) chunks.push(ch as Buffer);
        const tarText = gunzipSync(Buffer.concat(chunks)).toString('latin1');
        expect(tarText).toContain('src/a.txt');
        expect(tarText).not.toContain('node_modules');
        expect(await status(c.download('nope'))).toBe(404);
        expect(await status(c.download('../x'))).toBe(400);
        await c.purge();
        expect(fs.readdirSync(root)).toEqual([]);
        c.dispose();
    });

    test('watch runs in the worker and reports root-relative paths', async () => {
        const { root, c } = client();
        const seen: string[] = [];
        const close = await c.watch('', { recursive: true, excludes: [] }, (b) => seen.push(...b.paths.map((p) => `${b.type}:${p}`)), () => undefined);
        fs.writeFileSync(path.join(root, 'w.txt'), '1');
        await new Promise((r) => setTimeout(r, 700));
        await close();
        expect(seen).toContain('add:w.txt');
        c.dispose();
    });

    test('watch end callback fires when the worker dies', async () => {
        const { c } = client();
        let ended = false;
        await c.watch('', { recursive: true, excludes: [] }, () => undefined, () => (ended = true));
        c.kill();
        expect(ended).toBe(true);
        c.dispose();
    });
});

describe('API limits', () => {
    test('body > 64 KB -> 413 except fs/write; fs/read over 10 MB -> 413', async () => {
        const t = setup();
        const { id } = (await (await t.call('POST', '/sandboxes', t.admin, {})).json()) as { id: string };
        const tok = t.tokenFor(id);
        const big = 'a'.repeat(70 * 1024);
        expect((await t.call('POST', `/sandboxes/${id}/exec`, tok, { command: big })).status).toBe(413);
        expect((await t.call('POST', `/sandboxes/${id}/fs/mkdir`, tok, { path: big })).status).toBe(413);
        expect((await t.call('POST', '/sandboxes', t.admin, { title: big })).status).toBe(413);
        expect((await t.call('PUT', `/sandboxes/${id}/fs/write`, tok, { path: 'f.txt', content: big, encoding: 'utf8' })).status).toBe(200);
        const f = path.join(t.dir, id, 'huge.txt');
        fs.writeFileSync(f, '');
        fs.truncateSync(f, MAX_READ_BYTES + 1);
        const r = await t.call('GET', `/sandboxes/${id}/fs/read?path=huge.txt`, tok);
        expect(r.status).toBe(413);
        expect(await r.json()).toEqual({ error: 'file too large' });
    });

    test('stop and delete kill the sandbox fs worker', async () => {
        const t = setup();
        const { id } = (await (await t.call('POST', '/sandboxes', t.admin, {})).json()) as { id: string };
        const tok = t.tokenFor(id);
        await t.call('GET', `/sandboxes/${id}/fs/list?path=`, tok);
        const client = t.deps.service.fsFor(id);
        const pid = client.pid!;
        expect(pid).toBeGreaterThan(0);
        await t.call('POST', `/sandboxes/${id}/stop`, tok);
        expect(client.pid).toBeUndefined();
        await t.call('GET', `/sandboxes/${id}/fs/list?path=`, tok); // respawn
        expect(client.pid).toBeDefined();
        const pid2 = client.pid!;
        expect((await t.call('DELETE', `/sandboxes/${id}`, t.admin)).status).toBe(200);
        await new Promise((r) => setTimeout(r, 100)); // let the killed child be reaped
        expect(() => process.kill(pid2, 0)).toThrow();
        expect(fs.existsSync(path.join(t.dir, id))).toBe(false);
    });
});

describe('exec output cap', () => {
    test('capture keeps up to 1 MB and appends a note', () => {
        const cap = createOutputCapture(10);
        cap.push('12345');
        cap.push('6789012345');
        cap.push('more');
        expect(cap.truncated).toBe(true);
        expect(cap.result()).toBe(`1234567890${TRUNCATION_NOTE}`);
        const small = createOutputCapture();
        small.push('hi');
        expect(small.result()).toBe('hi');
        expect(small.truncated).toBe(false);
        expect(MAX_EXEC_OUTPUT_BYTES).toBe(1024 * 1024);
    });

    test('multibyte boundary is not left half-cut', () => {
        const cap = createOutputCapture(4);
        cap.push('abé'); // 4 bytes
        cap.push('é');
        expect(cap.result()).toBe(`abé${TRUNCATION_NOTE}`);
    });

    test('DockerRuntime.exec truncates and still returns the exit code', async () => {
        class FakeStreams extends DockerRuntime {
            override async openStream(_id: string, _o: unknown, onData: (s: string) => void) {
                const chunk = 'x'.repeat(256 * 1024);
                for (let i = 0; i < 10; i++) onData(chunk); // 2.5 MB
                return {
                    write() {},
                    async resize() {},
                    close() {},
                    pause() {},
                    resume() {},
                    done: Promise.resolve(7),
                };
            }
        }
        const rt = new FakeStreams(loadConfig({ RUNNER_SECRET: SECRET }));
        const r = await rt.exec('dk4900-aaaaaa', 'yes', 1000);
        expect(r.exitCode).toBe(7);
        expect(r.output.length).toBe(MAX_EXEC_OUTPUT_BYTES + TRUNCATION_NOTE.length);
        expect(r.output.endsWith(TRUNCATION_NOTE)).toBe(true);
    });
});

describe('state validation', () => {
    const good = { id: 'dk4901-abc123', port: 4901, createdAt: 1, lastActive: 2, title: 't' };

    test('validRecord rejects bad ids, ports and fields', () => {
        expect(validRecord(good)).toEqual(good);
        expect(validRecord({ ...good, id: '../etc' })).toBeNull();
        expect(validRecord({ ...good, id: 'dk4901-abc123/../x' })).toBeNull();
        expect(validRecord({ ...good, id: 'dk4902-abc123' })).toBeNull(); // port mismatch
        expect(validRecord({ ...good, port: '4901' })).toBeNull();
        expect(validRecord({ ...good, createdAt: 'x' })).toBeNull();
        expect(validRecord(null)).toBeNull();
        expect(validRecord('dk4901-abc123')).toBeNull();
    });

    test('invalid and duplicate-port records are dropped on load', () => {
        const dir = tmpDir();
        fs.writeFileSync(
            path.join(dir, '.state.json'),
            JSON.stringify({
                version: 1,
                sandboxes: [
                    good,
                    { ...good, id: '../../etc', port: 4902 },
                    { ...good, id: 'dk4901-zzzzzz' }, // same port as `good`
                    { id: 'dk4903-abc123', port: 4903, createdAt: 1, lastActive: 1 },
                ],
            }),
        );
        const reg = new Registry(dir, 4900, 4919);
        expect(reg.list().map((r) => r.id).sort()).toEqual(['dk4901-abc123', 'dk4903-abc123']);
        expect(fs.statSync(path.join(dir, '.state.json')).mode & 0o777).toBe(0o600);
    });
});

describe('docker runtime wiring (fake dockerode)', () => {
    function fakeRuntime(over: Record<string, unknown>) {
        const rt = new DockerRuntime(loadConfig({ RUNNER_SECRET: SECRET }));
        (rt as unknown as { docker: unknown }).docker = over;
        return rt;
    }

    test('ensureNetwork creates onlook-sbx with icc disabled, only when missing', async () => {
        const created: any[] = [];
        let existing: { Name: string }[] = [{ Name: 'onlook-sbx-extra' }];
        const rt = fakeRuntime({
            listNetworks: async () => existing,
            createNetwork: async (o: unknown) => void created.push(o),
        });
        await rt.ensureNetwork();
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({
            Name: 'onlook-sbx',
            Driver: 'bridge',
            Options: { 'com.docker.network.bridge.enable_icc': 'false' },
        });
        existing = [{ Name: 'onlook-sbx' }];
        await rt.ensureNetwork();
        expect(created).toHaveLength(1);
    });

    test('init sweeps leftover onlook.tmp containers', async () => {
        const removed: string[] = [];
        let filters: any;
        const rt = fakeRuntime({
            listNetworks: async () => [{ Name: 'onlook-sbx' }],
            listContainers: async (o: any) => {
                filters = o.filters;
                return [{ Id: 'c1' }, { Id: 'c2' }];
            },
            getContainer: (id: string) => ({ remove: async () => void removed.push(id) }),
        });
        await rt.init();
        expect(filters.label).toEqual(['onlook.tmp']);
        expect(removed).toEqual(['c1', 'c2']);
    });

    test('container is created with per-sandbox user, HOME=/tmp, isolated network, nofile limit', async () => {
        let cfg: any;
        const rt = fakeRuntime({
            listNetworks: async () => [{ Name: 'onlook-sbx' }],
            getContainer: () => ({
                inspect: async () => {
                    throw Object.assign(new Error('nf'), { statusCode: 404 });
                },
                remove: async () => {
                    throw Object.assign(new Error('nf'), { statusCode: 404 });
                },
            }),
            createContainer: async (c: unknown) => {
                cfg = c;
                return { start: async () => { throw new Error('stop here'); } };
            },
        });
        await expect(rt.start('dk4903-abc123', 4903, { uid: 61003, gid: 61003 })).rejects.toThrow('stop here');
        expect(cfg.User).toBe('61003:61003');
        expect(cfg.Env).toContain('HOME=/tmp');
        expect(cfg.HostConfig.NetworkMode).toBe('onlook-sbx');
        expect(cfg.HostConfig.Ulimits).toEqual([{ Name: 'nofile', Soft: 4096, Hard: 4096 }]);
        expect(cfg.HostConfig.PortBindings['3000/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '4903' }]);
        expect(cfg.HostConfig.CapDrop).toEqual(['ALL']);
    });
});

describe('websocket limits', () => {
    class FakeWs extends EventEmitter {
        readyState = 1; // OPEN
        bufferedAmount = 0;
        sent = 0;
        send() {
            this.sent++;
        }
    }

    test('Flow pauses above 4 MB buffered and resumes once drained', async () => {
        const ws = new FakeWs();
        const calls: string[] = [];
        const flow = new Flow(ws as unknown as WebSocket, 4 * 1024 * 1024, 512 * 1024, 5);
        flow.attach({ pause: () => calls.push('pause'), resume: () => calls.push('resume') });
        flow.send({ a: 1 });
        expect(calls).toEqual([]);
        ws.bufferedAmount = 5 * 1024 * 1024;
        flow.send({ a: 2 });
        flow.send({ a: 3 });
        expect(calls).toEqual(['pause']); // only once
        await new Promise((r) => setTimeout(r, 30));
        expect(calls).toEqual(['pause']); // still full
        ws.bufferedAmount = 100;
        await new Promise((r) => setTimeout(r, 30));
        expect(calls).toEqual(['pause', 'resume']);
        ws.bufferedAmount = 5 * 1024 * 1024;
        flow.send({ a: 4 });
        expect(calls).toEqual(['pause', 'resume', 'pause']); // can pause again
        ws.emit('close');
    });

    test('max 2 watch sockets per sandbox (oldest closed); maxPayload 1 MiB', async () => {
        const t = setup();
        const { id } = (await (await t.call('POST', '/sandboxes', t.admin, {})).json()) as { id: string };
        const server = createServer();
        const wss = attachWebSocket(server, t.deps);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as AddressInfo).port;
        const open = (token: string) =>
            new Promise<{ ws: WebSocket; closed: Promise<number> }>((resolve, reject) => {
                const ws = new WebSocket(`ws://127.0.0.1:${port}/sandboxes/${id}/watch?token=${token}`);
                const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
                ws.once('open', () => resolve({ ws, closed }));
                ws.once('error', reject);
            });
        try {
            const tok = t.tokenFor(id);
            const a = await open(tok);
            const b = await open(tok);
            const c = await open(tok);
            expect(await a.closed).toBe(1008);
            expect(b.ws.readyState).toBe(WebSocket.OPEN);
            expect(c.ws.readyState).toBe(WebSocket.OPEN);
            // bun swaps in its own `ws`, so the 1 MiB cap (close 1009) is asserted on the config, not on the wire
            expect((wss.options as { maxPayload?: number }).maxPayload).toBe(1024 * 1024);
            b.ws.close();
            await b.closed;
            c.ws.close();
            await c.closed;
        } finally {
            wss.close();
            server.close();
            t.deps.service.fsFor(id).dispose();
        }
    });
});
