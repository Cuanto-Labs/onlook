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

/** Pause the container stream above HIGH_WATER buffered bytes on the socket; resume once drained below LOW_WATER. */
export const WS_HIGH_WATER = 4 * 1024 * 1024;
export const WS_LOW_WATER = 512 * 1024;
export const WS_MAX_PAYLOAD = 1024 * 1024;

export interface Pausable {
    pause(): void;
    resume(): void;
}

export class Flow {
    private target: Pausable | null = null;
    private paused = false;
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly ws: WebSocket,
        private readonly high = WS_HIGH_WATER,
        private readonly low = WS_LOW_WATER,
        private readonly pollMs = 25,
    ) {
        ws.once('close', () => this.clear());
    }

    /** Bind the stream to throttle (a fresh stream starts unpaused). */
    attach(target: Pausable) {
        this.clear();
        this.target = target;
    }

    send(msg: unknown) {
        sendJson(this.ws, msg);
        if (this.paused || !this.target || this.ws.bufferedAmount <= this.high) return;
        this.paused = true;
        this.target.pause();
        this.timer = setInterval(() => {
            if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount <= this.low) {
                const t = this.target;
                this.clear();
                t?.resume();
            }
        }, this.pollMs);
    }

    private clear() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.paused = false;
    }
}
