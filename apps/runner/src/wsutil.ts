import { WebSocket } from 'ws';

export interface WsContext {
    id: string;
    url: URL;
    /** Count a message as activity for the idle reaper. */
    touch(): void;
}

export function sendJson(ws: WebSocket, msg: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function parseMsg(s: string): Record<string, unknown> | null {
    try {
        const v = JSON.parse(s);
        return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}
