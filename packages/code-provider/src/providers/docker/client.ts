/**
 * Thin REST + WebSocket helpers for the self-hosted runner (deploy/cuanto/runner/API.md).
 * Uses the platform `fetch` and `WebSocket` globals (browser, Node 22, Bun).
 */

export class RunnerError extends Error {
    constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
        this.name = 'RunnerError';
    }
}

export interface RunnerClientOptions {
    baseUrl: string;
    token?: string;
    /** Called once on a 401 to obtain a fresh token; the request is then retried. */
    refreshToken?: () => Promise<string | undefined>;
}

export interface RequestOptions {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    /** 'json' (default) or 'text' for routes like /health. */
    parse?: 'json' | 'text';
}

export function sandboxRoute(sandboxId: string, rest = ''): string {
    return `/sandboxes/${encodeURIComponent(sandboxId)}${rest}`;
}

function buildQuery(query?: Record<string, string | number | boolean | undefined>): string {
    if (!query) return '';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') {
            params.set(key, String(value));
        }
    }
    const str = params.toString();
    return str ? `?${str}` : '';
}

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
}

export class RunnerClient {
    private _baseUrl: string;
    private token: string | undefined;
    private readonly refreshToken?: () => Promise<string | undefined>;
    /** Shared by concurrent callers so a burst of 401s triggers one refresh. */
    private refreshing: Promise<string | undefined> | null = null;

    constructor(options: RunnerClientOptions) {
        this._baseUrl = normalizeBaseUrl(options.baseUrl);
        this.token = options.token;
        this.refreshToken = options.refreshToken;
    }

    get baseUrl(): string {
        return this._baseUrl;
    }

    /** Points the client (and every socket/stream built on it) at a different runner URL. */
    setBaseUrl(baseUrl: string) {
        this._baseUrl = normalizeBaseUrl(baseUrl);
    }

    get canRefresh(): boolean {
        return !!this.refreshToken;
    }

    /**
     * Obtains a fresh token and stores it. Concurrent calls share one in-flight request.
     * Resolves undefined (never rejects) when there is no refresher or it fails.
     */
    refresh(): Promise<string | undefined> {
        const refreshToken = this.refreshToken;
        if (!refreshToken) return Promise.resolve(undefined);
        if (!this.refreshing) {
            this.refreshing = (async () => {
                try {
                    const fresh = await refreshToken();
                    if (fresh) this.token = fresh;
                    return fresh;
                } catch {
                    return undefined;
                } finally {
                    this.refreshing = null;
                }
            })();
        }
        return this.refreshing;
    }

    setToken(token: string | undefined) {
        this.token = token;
    }

    getToken(): string | undefined {
        return this.token;
    }

    /** Authenticated fetch with one single-flight token refresh on 401; throws RunnerError on !ok. */
    private async fetchOk(method: string, path: string, options: RequestOptions): Promise<Response> {
        let sentToken: string | undefined;
        const send = () => {
            sentToken = this.token;
            const headers: Record<string, string> = {};
            if (sentToken) {
                headers.Authorization = `Bearer ${sentToken}`;
            }
            let body: string | undefined;
            if (options.body !== undefined) {
                headers['Content-Type'] = 'application/json';
                body = JSON.stringify(options.body);
            }
            return fetch(`${this._baseUrl}${path}${buildQuery(options.query)}`, {
                method,
                headers,
                body,
            });
        };

        let res = await send();
        if (res.status === 401 && this.refreshToken) {
            // Another caller may already have refreshed while this request was in flight.
            const fresh = this.token !== sentToken ? this.token : await this.refresh();
            if (fresh) {
                res = await send();
            }
        }

        if (!res.ok) {
            let message = `Runner request failed: ${method} ${path} (${res.status})`;
            try {
                const data = (await res.json()) as { error?: unknown };
                if (data && typeof data.error === 'string') {
                    message = data.error;
                }
            } catch {
                // non-JSON error body; keep the generic message
            }
            throw new RunnerError(message, res.status);
        }
        return res;
    }

    async request<T = unknown>(
        method: string,
        path: string,
        options: RequestOptions = {},
    ): Promise<T> {
        const res = await this.fetchOk(method, path, options);
        if (options.parse === 'text') {
            return (await res.text()) as T;
        }
        const text = await res.text();
        if (!text) return {} as T;
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new RunnerError(
                `Runner returned a non-JSON response: ${method} ${path} (${res.status})`,
                res.status,
            );
        }
    }

    /** Authenticated binary request (e.g. /fs/download). */
    async requestBlob(method: string, path: string, options: RequestOptions = {}): Promise<Blob> {
        const res = await this.fetchOk(method, path, options);
        return res.blob();
    }

    wsUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
        const base = this._baseUrl.replace(/^http/, 'ws');
        const all = { ...query, token: this.token };
        return `${base}${path}${buildQuery(all)}`;
    }
}

export type RunnerMessage = { type: string; [key: string]: unknown };

export interface RunnerSocketOptions {
    /** Reopen the socket after unexpected closes (watchers). */
    reconnect?: boolean;
    maxReconnects?: number;
}

/** JSON-frame WebSocket wrapper with optional bounded auto-reconnect. */
export class RunnerSocket {
    private ws: WebSocket | null = null;
    private closedByUser = false;
    private reconnects = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly giveUpListeners = new Set<() => void>();
    private readonly messageListeners = new Set<(message: RunnerMessage) => void>();
    private readonly closeListeners = new Set<(code: number) => void>();

    constructor(
        private readonly client: RunnerClient,
        private readonly path: string,
        private readonly query: Record<string, string | number | boolean | undefined> = {},
        private readonly options: RunnerSocketOptions = {},
    ) {}

    get isOpen(): boolean {
        return this.ws?.readyState === 1;
    }

    async connect(): Promise<void> {
        this.closedByUser = false;
        try {
            await this.open(true);
        } catch (error) {
            // A rejected handshake (expired token) surfaces as a pre-open close; retry once with a fresh token.
            if (this.closedByUser || !this.client.canRefresh) throw error;
            const fresh = await this.client.refresh();
            if (!fresh) throw error;
            await this.open(true);
        }
    }

    private open(initial: boolean): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let opened = false;
            const ws = new WebSocket(this.client.wsUrl(this.path, this.query));
            this.ws = ws;
            ws.addEventListener('open', () => {
                opened = true;
                if (!initial) this.reconnects = 0;
                resolve();
            });
            ws.addEventListener('message', (event: MessageEvent) => {
                let parsed: RunnerMessage;
                try {
                    parsed = JSON.parse(String(event.data)) as RunnerMessage;
                } catch {
                    return;
                }
                for (const listener of this.messageListeners) {
                    listener(parsed);
                }
            });
            ws.addEventListener('error', () => {
                if (!opened) {
                    reject(new Error(`Runner WebSocket failed to connect: ${this.path}`));
                }
            });
            ws.addEventListener('close', (event: CloseEvent) => {
                if (this.ws === ws) this.ws = null;
                if (!opened) {
                    reject(new Error(`Runner WebSocket closed before opening: ${this.path}`));
                    return;
                }
                for (const listener of this.closeListeners) {
                    listener(event.code);
                }
                if (!this.closedByUser && this.options.reconnect) {
                    this.scheduleReconnect();
                }
            });
        });
    }

    private scheduleReconnect() {
        const max = this.options.maxReconnects ?? 5;
        if (this.reconnects >= max) {
            for (const listener of this.giveUpListeners) {
                listener();
            }
            return;
        }
        this.reconnects++;
        const delay = Math.min(1000 * 2 ** (this.reconnects - 1), 10000);
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.closedByUser) return;
            // The socket may have died because the token expired: refresh before retrying.
            await this.client.refresh();
            if (this.closedByUser) return;
            this.open(false).catch(() => this.scheduleReconnect());
        }, delay);
    }

    send(data: unknown) {
        if (!this.isOpen || !this.ws) {
            throw new Error(`Runner WebSocket not open: ${this.path}`);
        }
        this.ws.send(JSON.stringify(data));
    }

    onMessage(callback: (message: RunnerMessage) => void): () => void {
        this.messageListeners.add(callback);
        return () => {
            this.messageListeners.delete(callback);
        };
    }

    onClose(callback: (code: number) => void): () => void {
        this.closeListeners.add(callback);
        return () => {
            this.closeListeners.delete(callback);
        };
    }

    /** Fires once reconnecting is exhausted; the socket stays closed afterwards. */
    onGiveUp(callback: () => void): () => void {
        this.giveUpListeners.add(callback);
        return () => {
            this.giveUpListeners.delete(callback);
        };
    }

    close() {
        this.closedByUser = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const ws = this.ws;
        this.ws = null;
        try {
            ws?.close();
        } catch {
            // already closed
        }
    }
}
