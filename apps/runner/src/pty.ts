import type { WebSocket } from 'ws';
import type { ContainerRuntime } from './runtime.js';
import { Flow, parseMsg, sendJson, type WsContext } from './wsutil.js';

const clamp = (n: number, dflt: number) => (Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 500) : dflt);

/** Interactive bash (TTY) in the sandbox container. */
export async function handlePty(ws: WebSocket, ctx: WsContext, runtime: ContainerRuntime) {
    const cols = clamp(Number(ctx.url.searchParams.get('cols')), 80);
    const rows = clamp(Number(ctx.url.searchParams.get('rows')), 24);
    const flow = new Flow(ws);
    const handle = await runtime.openStream(
        ctx.id,
        { cmd: ['bash'], tty: true, stdin: true, cols, rows },
        (data) => flow.send({ type: 'output', data }),
    );
    flow.attach(handle);
    handle.done.then((code) => {
        sendJson(ws, { type: 'exit', code });
        ws.close(1000, 'exit');
    });
    ws.on('message', (raw) => {
        ctx.touch();
        const msg = parseMsg(raw.toString());
        if (msg?.type === 'input' && typeof msg.data === 'string') handle.write(msg.data);
        else if (msg?.type === 'resize') {
            void handle.resize(clamp(Number(msg.cols), cols), clamp(Number(msg.rows), rows));
        }
    });
    ws.on('close', () => handle.close());
}
