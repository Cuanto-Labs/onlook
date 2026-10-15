import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { canAccess, verifyToken } from './auth.js';
import { buildBgCommand } from './exec.js';
import { isValidId } from './ports.js';
import { handlePty } from './pty.js';
import type { Deps } from './server.js';
import { startWatch } from './watch.js';
import { Flow, parseMsg, sendJson, WS_MAX_PAYLOAD, type WsContext } from './wsutil.js';

const ROUTE = /^\/sandboxes\/([^/]+)\/(watch|pty|task\/dev|bg)$/;

function reject(socket: Duplex, status: number, text: string) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

/** Attach the WebSocket routes of API.md to an existing HTTP server (same port as REST). */
export function attachWebSocket(server: Server, deps: Deps): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
    const watchers = new Map<string, WebSocket[]>();

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        void (async () => {
            const url = new URL(req.url ?? '/', 'http://runner');
            const m = ROUTE.exec(url.pathname);
            if (!m) return reject(socket, 404, 'Not Found');
            const id = m[1]!;
            const kind = m[2]!;
            const token = url.searchParams.get('token');
            const payload = token ? verifyToken(token, deps.config.secret) : null;
            if (!payload) return reject(socket, 401, 'Unauthorized');
            if (!canAccess(payload, id)) return reject(socket, 403, 'Forbidden');
            if (!isValidId(id) || !deps.registry.get(id)) return reject(socket, 404, 'Not Found');
            if (kind !== 'watch' && !(await deps.runtime.isRunning(id))) return reject(socket, 409, 'Conflict');

            wss.handleUpgrade(req, socket, head, (ws) => {
                const ctx: WsContext = { id, url, touch: () => deps.registry.touch(id) };
                ctx.touch();
                ws.on('error', () => undefined);
                run(ws, kind, ctx, deps, watchers).catch((e) => {
                    console.error(`[ws] ${kind} ${id}:`, e instanceof Error ? e.message : e);
                    ws.close(1011, 'internal error');
                });
            });
        })().catch(() => reject(socket, 500, 'Internal Server Error'));
    });
    return wss;
}

function run(
    ws: WebSocket,
    kind: string,
    ctx: WsContext,
    deps: Deps,
    watchers: Map<string, WebSocket[]>,
): Promise<void> {
    switch (kind) {
        case 'watch':
            return handleWatch(ws, ctx, deps, watchers);
        case 'pty':
            return handlePty(ws, ctx, deps.runtime);
        case 'task/dev':
            return handleTaskDev(ws, ctx, deps);
        default:
            return handleBg(ws, ctx, deps);
    }
}

const MAX_WATCH_SOCKETS = 2;

/** At most MAX_WATCH_SOCKETS watch sockets per sandbox: opening another closes the oldest. */
async function handleWatch(ws: WebSocket, ctx: WsContext, deps: Deps, watchers: Map<string, WebSocket[]>) {
    const list = watchers.get(ctx.id) ?? [];
    watchers.set(ctx.id, list);
    while (list.length >= MAX_WATCH_SOCKETS) list.shift()!.close(1008, 'too many watchers');
    list.push(ws);
    const forget = () => {
        const i = list.indexOf(ws);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0 && watchers.get(ctx.id) === list) watchers.delete(ctx.id);
    };
    ws.once('close', forget);

    const q = ctx.url.searchParams;
    const excludes = (q.get('excludes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    let closed = ws.readyState !== ws.OPEN;
    let closeWatch: (() => Promise<void>) | null = null;
    ws.once('close', () => {
        closed = true;
        void closeWatch?.();
    });
    // The watcher runs inside the sandbox's fs worker (unprivileged); if it dies the socket closes.
    const close = await deps.service
        .fsFor(ctx.id)
        .watch(
            q.get('path') ?? '',
            { recursive: q.get('recursive') !== 'false', excludes },
            (batch) => sendJson(ws, batch),
            () => ws.close(1011, 'watcher stopped'),
        );
    closeWatch = close;
    if (closed) void close();
    ws.on('message', () => ctx.touch());
}

/** Container logs: last 200 lines, then follow; `restart` restarts the container and re-attaches. */
async function handleTaskDev(ws: WebSocket, ctx: WsContext, deps: Deps) {
    const rt = deps.runtime;
    let closed = false;
    let current: { close(): void } | null = null;
    const flow = new Flow(ws);
    const pump = async () => {
        let tail = 200;
        while (!closed) {
            let follow;
            try {
                follow = await rt.followLogs(ctx.id, tail, (data) => flow.send({ type: 'output', data }));
            } catch {
                break; // container gone
            }
            current = follow;
            flow.attach(follow);
            await follow.ended;
            tail = 0;
            if (closed) break;
            await new Promise((r) => setTimeout(r, 500));
            if (!(await rt.isRunning(ctx.id))) break;
        }
        if (!closed) ws.close(1000, 'container stopped');
    };
    ws.on('message', (raw) => {
        ctx.touch();
        if (parseMsg(raw.toString())?.type === 'restart') {
            rt.restart(ctx.id).catch((e) =>
                sendJson(ws, { type: 'output', data: `\r\n[runner] restart failed: ${e instanceof Error ? e.message : e}\r\n` }),
            );
        }
    });
    ws.on('close', () => {
        closed = true;
        current?.close();
    });
    void pump();
}

/** Run an arbitrary command in the container; `kill` terminates its process tree via a second exec. */
async function handleBg(ws: WebSocket, ctx: WsContext, deps: Deps) {
    const command = ctx.url.searchParams.get('command');
    if (!command?.trim()) return void ws.close(1008, 'command is required');
    const bg = buildBgCommand(command);
    const flow = new Flow(ws);
    const handle = await deps.runtime.openStream(
        ctx.id,
        { cmd: bg.cmd, tty: false, stdin: false },
        (data) => flow.send({ type: 'output', data }),
    );
    flow.attach(handle);
    const kill = () => deps.runtime.exec(ctx.id, bg.killScript, 20_000).catch(() => undefined);
    let exited = false;
    handle.done.then((code) => {
        exited = true;
        sendJson(ws, { type: 'exit', code });
        deps.runtime.exec(ctx.id, `rm -f ${bg.pidFile}`, 5_000).catch(() => undefined);
        ws.close(1000, 'exit');
    });
    ws.on('message', (raw) => {
        ctx.touch();
        if (parseMsg(raw.toString())?.type === 'kill' && !exited) void kill();
    });
    ws.on('close', () => {
        if (!exited) void kill();
        handle.close();
    });
}
