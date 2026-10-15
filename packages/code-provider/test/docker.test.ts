import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

import { CodeProvider, defaultCodeProvider, providerForSandboxId } from '../src';
import { DockerProvider, RunnerCommandError, isDockerSandboxId } from '../src/providers/docker';
import { signRunnerToken } from '../src/providers/docker/token';

const SANDBOX_ID = 'dk4901-a8k2pq';
const BASE = 'http://runner.test';
const ROUTE = `/sandboxes/${SANDBOX_ID}`;

interface RecordedCall {
    url: URL;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

const realFetch = globalThis.fetch;
let calls: RecordedCall[] = [];
let responder: (call: RecordedCall) => { status?: number; body?: unknown; text?: string };

function installFetch() {
    calls = [];
    responder = () => ({ body: {} });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const call: RecordedCall = {
            url: new URL(String(input)),
            method: init?.method ?? 'GET',
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        calls.push(call);
        const res = responder(call);
        const payload = res.text ?? JSON.stringify(res.body ?? {});
        return new Response(payload, { status: res.status ?? 200 });
    }) as typeof fetch;
}

function newProvider() {
    return new DockerProvider({ sandboxId: SANDBOX_ID, runnerUrl: BASE, token: 'tok' });
}

beforeEach(installFetch);
afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('DockerProvider file operations', () => {
    test('writeFile sends utf8 text', async () => {
        const res = await newProvider().writeFile({ args: { path: 'src/a.ts', content: 'hi' } });
        expect(res.success).toBe(true);
        const call = calls[0]!;
        expect(call.method).toBe('PUT');
        expect(call.url.href).toBe(`${BASE}${ROUTE}/fs/write`);
        expect(call.headers.Authorization).toBe('Bearer tok');
        expect(call.body).toEqual({ path: 'src/a.ts', content: 'hi', encoding: 'utf8' });
    });

    test('writeFile sends Uint8Array as base64 and forwards overwrite', async () => {
        const bytes = new Uint8Array([0, 1, 2, 250, 255]);
        await newProvider().writeFile({ args: { path: 'a.png', content: bytes, overwrite: false } });
        expect(calls[0]!.body).toEqual({
            path: 'a.png',
            content: Buffer.from(bytes).toString('base64'),
            encoding: 'base64',
            overwrite: false,
        });
    });

    test('writeFile returns success=false on runner error', async () => {
        responder = () => ({ status: 409, body: { error: 'exists' } });
        const res = await newProvider().writeFile({ args: { path: 'a', content: 'x', overwrite: false } });
        expect(res.success).toBe(false);
    });

    test('readFile text maps to SandboxFile', async () => {
        responder = () => ({ body: { type: 'text', content: 'hello' } });
        const { file } = await newProvider().readFile({ args: { path: 'a.txt' } });
        const call = calls[0]!;
        expect(call.method).toBe('GET');
        expect(call.url.pathname).toBe(`${ROUTE}/fs/read`);
        expect(call.url.searchParams.get('path')).toBe('a.txt');
        expect(file.type).toBe('text');
        expect(file.path).toBe('a.txt');
        expect(file.content).toBe('hello');
        expect(file.toString()).toBe('hello');
    });

    test('readFile binary decodes base64 into Uint8Array', async () => {
        const bytes = new Uint8Array([0, 9, 200, 255]);
        responder = () => ({
            body: { type: 'binary', content: Buffer.from(bytes).toString('base64') },
        });
        const { file } = await newProvider().readFile({ args: { path: 'a.png' } });
        expect(file.type).toBe('binary');
        expect(file.content).toBeInstanceOf(Uint8Array);
        expect(Array.from(file.content as Uint8Array)).toEqual(Array.from(bytes));
        expect(file.toString()).toBe(Buffer.from(bytes).toString('base64'));
    });

    test('readFile throws with the runner error message', async () => {
        responder = () => ({ status: 404, body: { error: 'not found' } });
        await expect(newProvider().readFile({ args: { path: 'nope' } })).rejects.toThrow(
            'Failed to read file nope: not found',
        );
    });

    test('listFiles', async () => {
        responder = () => ({
            body: { files: [{ name: 'a', type: 'file', isSymlink: false }] },
        });
        const res = await newProvider().listFiles({ args: { path: 'src' } });
        expect(calls[0]!.url.pathname).toBe(`${ROUTE}/fs/list`);
        expect(calls[0]!.url.searchParams.get('path')).toBe('src');
        expect(res.files).toEqual([{ name: 'a', type: 'file', isSymlink: false }]);
    });

    test('statFile', async () => {
        responder = () => ({
            body: { type: 'directory', isSymlink: false, size: 4, mtime: 1, ctime: 2, atime: 3 },
        });
        const res = await newProvider().statFile({ args: { path: 'src' } });
        expect(calls[0]!.url.pathname).toBe(`${ROUTE}/fs/stat`);
        expect(res).toEqual({
            type: 'directory',
            isSymlink: false,
            size: 4,
            mtime: 1,
            ctime: 2,
            atime: 3,
        });
    });

    test('deleteFiles', async () => {
        await newProvider().deleteFiles({ args: { path: 'src', recursive: true } });
        const call = calls[0]!;
        expect(call.method).toBe('DELETE');
        expect(call.url.pathname).toBe(`${ROUTE}/fs`);
        expect(call.url.searchParams.get('path')).toBe('src');
        expect(call.url.searchParams.get('recursive')).toBe('true');
    });

    test('renameFile, copyFiles, createDirectory', async () => {
        const provider = newProvider();
        await provider.renameFile({ args: { oldPath: 'a', newPath: 'b' } });
        await provider.copyFiles({
            args: { sourcePath: 'a', targetPath: 'c', recursive: true, overwrite: false },
        });
        await provider.createDirectory({ args: { path: 'd/e' } });
        expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
            ['POST', `${ROUTE}/fs/rename`],
            ['POST', `${ROUTE}/fs/copy`],
            ['POST', `${ROUTE}/fs/mkdir`],
        ]);
        expect(calls[0]!.body).toEqual({ oldPath: 'a', newPath: 'b' });
        expect(calls[1]!.body).toEqual({
            sourcePath: 'a',
            targetPath: 'c',
            recursive: true,
            overwrite: false,
        });
        expect(calls[2]!.body).toEqual({ path: 'd/e' });
    });

    test('runCommand returns merged output', async () => {
        responder = () => ({ body: { output: 'out\n', exitCode: 0 } });
        const res = await newProvider().runCommand({ args: { command: 'ls' } });
        expect(calls[0]!.method).toBe('POST');
        expect(calls[0]!.url.pathname).toBe(`${ROUTE}/exec`);
        expect(calls[0]!.body).toEqual({ command: 'ls' });
        expect(res.output).toBe('out\n');
    });

    test('gitStatus', async () => {
        responder = () => ({ body: { changedFiles: ['a.ts'] } });
        const res = await newProvider().gitStatus({});
        expect(calls[0]!.url.pathname).toBe(`${ROUTE}/git-status`);
        expect(res.changedFiles).toEqual(['a.ts']);
    });

    test('runCommand throws with the output on a non-zero exit', async () => {
        responder = () => ({ body: { output: 'boom: not found\n', exitCode: 127 } });
        const error = await newProvider()
            .runCommand({ args: { command: 'nope' } })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RunnerCommandError);
        expect((error as RunnerCommandError).exitCode).toBe(127);
        expect((error as RunnerCommandError).output).toBe('boom: not found\n');
        expect((error as Error).message).toBe('boom: not found');
    });

    test('runCommand error message falls back to the exit code when output is empty', async () => {
        responder = () => ({ body: { output: '', exitCode: 1 } });
        await expect(newProvider().runCommand({ args: { command: 'false' } })).rejects.toThrow(
            'Command exited with code 1',
        );
    });

    test('downloadFiles fetches /fs/download with Bearer and returns an object URL', async () => {
        const realFetchImpl = globalThis.fetch;
        let auth: string | undefined;
        let requested: URL | undefined;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            requested = new URL(String(input));
            auth = (init?.headers as Record<string, string>).Authorization;
            return new Response(new Uint8Array([31, 139, 8]), { status: 200 });
        }) as typeof fetch;
        const savedCreate = URL.createObjectURL;
        let blobSize = -1;
        URL.createObjectURL = ((blob: Blob) => {
            blobSize = blob.size;
            return 'blob:test-1';
        }) as typeof URL.createObjectURL;
        try {
            const res = await newProvider().downloadFiles({ args: { path: '.' } });
            expect(res).toEqual({ url: 'blob:test-1' });
            expect(blobSize).toBe(3);
            expect(requested!.pathname).toBe(`${ROUTE}/fs/download`);
            expect(requested!.searchParams.get('path')).toBe('.');
            expect(auth).toBe('Bearer tok');
        } finally {
            URL.createObjectURL = savedCreate;
            globalThis.fetch = realFetchImpl;
        }
    });

    test('ping hits the authenticated per-sandbox route', async () => {
        expect(await newProvider().ping()).toBe(true);
        expect(calls[0]!.method).toBe('POST');
        expect(calls[0]!.url.pathname).toBe(`${ROUTE}/ping`);
        expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
        responder = () => ({ status: 500, body: { error: 'down' } });
        expect(await newProvider().ping()).toBe(false);
    });

    test('a non-JSON 2xx response raises a RunnerError instead of a SyntaxError', async () => {
        responder = () => ({ text: '<html>proxy</html>' });
        await expect(newProvider().gitStatus({})).rejects.toThrow('non-JSON');
    });
});

describe('DockerProvider lifecycle', () => {
    test('initialize fetches a session, starts the sandbox and destroy clears the keepalive', async () => {
        const provider = new DockerProvider({
            sandboxId: SANDBOX_ID,
            userId: 'u1',
            runnerUrl: BASE,
            getSession: async (id, userId) => {
                expect(id).toBe(SANDBOX_ID);
                expect(userId).toBe('u1');
                return { token: 'fresh' };
            },
        });
        await provider.initialize({});
        expect(calls).toHaveLength(1);
        expect(calls[0]!.method).toBe('POST');
        expect(calls[0]!.url.pathname).toBe(`${ROUTE}/start`);
        expect(calls[0]!.headers.Authorization).toBe('Bearer fresh');
        await provider.destroy();
    });

    test('pauseProject stops the container', async () => {
        await newProvider().pauseProject({});
        expect(calls[0]!.url.pathname).toBe(`${ROUTE}/stop`);
    });

    test('401 triggers one token refresh through getSession', async () => {
        let issued = 0;
        const provider = new DockerProvider({
            sandboxId: SANDBOX_ID,
            runnerUrl: BASE,
            token: 'old',
            getSession: async () => ({ token: `new${++issued}` }),
        });
        responder = (call) =>
            call.headers.Authorization === 'Bearer new1'
                ? { body: { changedFiles: [] } }
                : { status: 401, body: { error: 'unauthorized' } };
        await provider.gitStatus({});
        expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer old', 'Bearer new1']);
    });

    test('concurrent 401s share a single token refresh', async () => {
        let issued = 0;
        const provider = new DockerProvider({
            sandboxId: SANDBOX_ID,
            runnerUrl: BASE,
            token: 'old',
            getSession: async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return { token: `new${++issued}` };
            },
        });
        responder = (call) =>
            call.headers.Authorization === 'Bearer new1'
                ? { body: { changedFiles: [] } }
                : { status: 401, body: { error: 'unauthorized' } };
        await Promise.all([provider.gitStatus({}), provider.gitStatus({}), provider.gitStatus({})]);
        expect(issued).toBe(1);
        expect(calls.filter((c) => c.headers.Authorization === 'Bearer new1')).toHaveLength(3);
    });

    test('a new runnerUrl from getSession updates the existing client in place', async () => {
        const provider = new DockerProvider({
            sandboxId: SANDBOX_ID,
            runnerUrl: BASE,
            token: 'old',
            getSession: async () => ({ token: 'new', runnerUrl: 'http://other.test' }),
        });
        responder = (call) =>
            call.url.host === 'other.test'
                ? { body: { changedFiles: [] } }
                : { status: 401, body: { error: 'unauthorized' } };
        await provider.gitStatus({});
        expect(calls.map((c) => c.url.host)).toEqual(['runner.test', 'other.test']);
    });

    test('createProjectFromGit is unavailable', async () => {
        await expect(
            DockerProvider.createProjectFromGit({ repoUrl: 'x', branch: 'main' }),
        ).rejects.toThrow('GitHub import is not available on the self-hosted runner');
    });
});

describe('DockerProvider server statics', () => {
    const saved = { url: process.env.RUNNER_INTERNAL_URL, secret: process.env.RUNNER_SECRET };
    beforeEach(() => {
        process.env.RUNNER_INTERNAL_URL = BASE;
        process.env.RUNNER_SECRET = 'shh';
    });
    afterEach(() => {
        process.env.RUNNER_INTERNAL_URL = saved.url;
        process.env.RUNNER_SECRET = saved.secret;
    });

    test('createProject from template posts no fromId and uses an admin token', async () => {
        responder = () => ({ body: { id: 'dk4902-zzzzzz', port: 4902 } });
        const res = await DockerProvider.createProject({
            source: 'template',
            id: 'pt_EphPmsurimGCQdiB44wa7s',
            title: 'T',
        });
        expect(res).toEqual({ id: 'dk4902-zzzzzz' });
        const call = calls[0]!;
        expect(call.method).toBe('POST');
        expect(call.url.pathname).toBe('/sandboxes');
        expect(call.body).toEqual({ title: 'T' });
        const payload = JSON.parse(
            Buffer.from(call.headers.Authorization!.slice(7).split('.')[0]!, 'base64url').toString(),
        );
        expect(payload.sid).toBe('*');
    });

    test('createProject forks when the source is a docker sandbox id', async () => {
        responder = () => ({ body: { id: 'dk4903-yyyyyy', port: 4903 } });
        await DockerProvider.createProject({ source: 'template', id: SANDBOX_ID });
        expect(calls[0]!.body).toEqual({ fromId: SANDBOX_ID });
        await DockerProvider.createProject({ source: SANDBOX_ID, id: 'x' });
        expect(calls[1]!.body).toEqual({ fromId: SANDBOX_ID });
    });

    test('stop and delete use admin routes', async () => {
        await DockerProvider.stopSandbox(SANDBOX_ID);
        await DockerProvider.deleteSandbox(SANDBOX_ID);
        expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
            ['POST', `${ROUTE}/stop`],
            ['DELETE', ROUTE],
        ]);
    });
});

describe('runner token', () => {
    test('matches the reference HMAC format', async () => {
        const payload = { sid: SANDBOX_ID, uid: 'user-1', exp: 1_900_000_000 };
        const token = await signRunnerToken('secret', payload);
        const [payloadPart, sig] = token.split('.');
        expect(token.split('.')).toHaveLength(2);
        expect(JSON.parse(Buffer.from(payloadPart!, 'base64url').toString())).toEqual(payload);
        const expected = createHmac('sha256', 'secret').update(payloadPart!).digest('base64url');
        expect(sig).toBe(expected);
        expect(token).not.toMatch(/[+/=]/);
    });
});

describe('sandbox id helpers', () => {
    test('isDockerSandboxId', () => {
        expect(isDockerSandboxId('dk4901-a8k2pq')).toBe(true);
        expect(isDockerSandboxId('dk19999-abc123')).toBe(true);
        expect(isDockerSandboxId('dk490-a8k2pq')).toBe(false);
        expect(isDockerSandboxId('dk4901-A8k2pq')).toBe(false);
        expect(isDockerSandboxId('dk4901-a8k2pqx')).toBe(false);
        expect(isDockerSandboxId('pt_EphPmsurimGCQdiB44wa7s')).toBe(false);
        expect(isDockerSandboxId('')).toBe(false);
    });

    test('providerForSandboxId', () => {
        expect(providerForSandboxId('dk4901-a8k2pq')).toBe(CodeProvider.Docker);
        expect(providerForSandboxId('xzsy8c')).toBe(CodeProvider.CodeSandbox);
    });

    test('defaultCodeProvider reads NEXT_PUBLIC_CODE_PROVIDER', () => {
        const saved = process.env.NEXT_PUBLIC_CODE_PROVIDER;
        process.env.NEXT_PUBLIC_CODE_PROVIDER = 'docker';
        expect(defaultCodeProvider()).toBe(CodeProvider.Docker);
        process.env.NEXT_PUBLIC_CODE_PROVIDER = 'code_sandbox';
        expect(defaultCodeProvider()).toBe(CodeProvider.CodeSandbox);
        delete process.env.NEXT_PUBLIC_CODE_PROVIDER;
        expect(defaultCodeProvider()).toBe(CodeProvider.CodeSandbox);
        if (saved !== undefined) process.env.NEXT_PUBLIC_CODE_PROVIDER = saved;
    });
});

describe('DockerProvider sockets', () => {
    const RealWebSocket = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];

    class FakeWebSocket {
        readyState = 0;
        sent: string[] = [];
        private listeners = new Map<string, Array<(event: unknown) => void>>();
        constructor(public url: string) {
            sockets.push(this);
            queueMicrotask(() => {
                this.readyState = 1;
                this.emit('open', {});
            });
        }
        addEventListener(type: string, cb: (event: unknown) => void) {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
        }
        emit(type: string, event: unknown) {
            for (const cb of this.listeners.get(type) ?? []) cb(event);
        }
        send(data: string) {
            this.sent.push(data);
        }
        close() {
            this.readyState = 3;
            this.emit('close', { code: 1000 });
        }
    }

    beforeEach(() => {
        sockets.length = 0;
        globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    });
    afterEach(() => {
        globalThis.WebSocket = RealWebSocket;
    });

    test('watchFiles opens /watch with query + token and forwards events', async () => {
        const events: Array<{ type: string; paths: string[] }> = [];
        const { watcher } = await newProvider().watchFiles({
            args: { path: '.', recursive: true, excludes: ['a', 'b'] },
            onFileChange: async (event) => {
                events.push(event);
            },
        });
        const url = new URL(sockets[0]!.url);
        expect(url.protocol).toBe('ws:');
        expect(url.pathname).toBe(`${ROUTE}/watch`);
        expect(url.searchParams.get('path')).toBe('.');
        expect(url.searchParams.get('recursive')).toBe('true');
        expect(url.searchParams.get('excludes')).toBe('a,b');
        expect(url.searchParams.get('token')).toBe('tok');
        sockets[0]!.emit('message', {
            data: JSON.stringify({ type: 'change', paths: ['src/a.ts'] }),
        });
        expect(events).toEqual([{ type: 'change', paths: ['src/a.ts'] }]);
        await watcher.stop();
    });

    test('watch frames with several paths emit one event per path (never a fake rename)', async () => {
        const events: Array<{ type: string; paths: string[] }> = [];
        const { watcher } = await newProvider().watchFiles({
            args: { path: '.', recursive: true },
            onFileChange: async (event) => {
                events.push(event);
            },
        });
        sockets[0]!.emit('message', {
            data: JSON.stringify({ type: 'change', paths: ['a.ts', 'b.ts'] }),
        });
        sockets[0]!.emit('message', {
            data: JSON.stringify({ type: 'remove', paths: ['c.ts', 'd.ts', 'e.ts'] }),
        });
        expect(events).toEqual([
            { type: 'change', paths: ['a.ts'] },
            { type: 'change', paths: ['b.ts'] },
            { type: 'remove', paths: ['c.ts'] },
            { type: 'remove', paths: ['d.ts'] },
            { type: 'remove', paths: ['e.ts'] },
        ]);
        await watcher.stop();
    });

    test('starting a watcher twice closes the previous socket', async () => {
        const { watcher } = await newProvider().watchFiles({ args: { path: '.' } });
        await watcher.start({ args: { path: '.' } });
        expect(sockets).toHaveLength(2);
        expect(sockets[0]!.readyState).toBe(3);
        expect(sockets[1]!.readyState).toBe(1);
        await watcher.stop();
    });

    test('dev task replays logs on open and sends restart', async () => {
        const provider = newProvider();
        const { task } = await provider.getTask({ args: { id: 'dev' } });
        const opened = task.open();
        await Promise.resolve();
        await Promise.resolve();
        sockets[0]!.emit('message', { data: JSON.stringify({ type: 'output', data: 'line1\n' }) });
        expect(await opened).toBe('line1\n');
        expect(new URL(sockets[0]!.url).pathname).toBe(`${ROUTE}/task/dev`);
        const live: string[] = [];
        task.onOutput((data) => live.push(data));
        sockets[0]!.emit('message', { data: JSON.stringify({ type: 'output', data: 'line2\n' }) });
        expect(live).toEqual(['line2\n']);
        await task.restart();
        expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'restart' })]);
        expect((await provider.getTask({ args: { id: 'dev' } })).task).toBe(task);
        await expect(provider.getTask({ args: { id: 'other' } })).rejects.toThrow('not found');
        await provider.destroy();
    });

    test('terminal opens /pty with size and sends input', async () => {
        const { terminal } = await newProvider().createTerminal({});
        const out: string[] = [];
        terminal.onOutput((data) => out.push(data));
        await terminal.open({ cols: 80, rows: 24 });
        const url = new URL(sockets[0]!.url);
        expect(url.pathname).toBe(`${ROUTE}/pty`);
        expect(url.searchParams.get('cols')).toBe('80');
        expect(url.searchParams.get('rows')).toBe('24');
        await terminal.write('ls');
        expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'input', data: 'ls' })]);
        sockets[0]!.emit('message', { data: JSON.stringify({ type: 'output', data: 'x' }) });
        expect(out).toEqual(['x']);
        await terminal.kill();
    });
});
