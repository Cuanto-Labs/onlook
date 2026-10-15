import {
    ProviderBackgroundCommand,
    ProviderTask,
    ProviderTerminal,
    type ProviderTerminalShellSize,
} from '../../types';
import { RunnerSocket, sandboxRoute, type RunnerClient, type RunnerMessage } from './client';

const MAX_BUFFER_CHUNKS = 500;
const SETTLE_QUIET_MS = 150;
const SETTLE_MAX_MS = 2000;

/**
 * Shared plumbing for runner output streams (dev task logs, background commands):
 * buffers output so `open()` can return what has been printed so far, then fans out new chunks.
 */
abstract class DockerOutputStream {
    protected socket: RunnerSocket | null = null;
    protected buffer: string[] = [];
    protected readonly listeners = new Set<(data: string) => void>();
    private connecting: Promise<void> | null = null;
    protected disposed = false;

    constructor(protected readonly client: RunnerClient) {}

    protected abstract createSocket(): RunnerSocket;

    protected handleMessage(message: RunnerMessage): void {
        if (message.type === 'output' && typeof message.data === 'string') {
            this.buffer.push(message.data);
            if (this.buffer.length > MAX_BUFFER_CHUNKS) {
                this.buffer.splice(0, this.buffer.length - MAX_BUFFER_CHUNKS);
            }
            for (const listener of this.listeners) {
                listener(message.data);
            }
        }
    }

    protected async ensureConnected(): Promise<RunnerSocket> {
        this.disposed = false;
        if (this.socket?.isOpen) return this.socket;
        if (!this.connecting) {
            const socket = this.createSocket();
            socket.onMessage((message) => this.handleMessage(message));
            socket.onClose(() => {
                if (this.socket === socket) this.socket = null;
            });
            this.connecting = socket
                .connect()
                .then(() => {
                    this.socket = socket;
                })
                .finally(() => {
                    this.connecting = null;
                });
        }
        await this.connecting;
        return this.socket as unknown as RunnerSocket;
    }

    /** Resolves once output has gone quiet (or a cap), so the initial log replay is captured. */
    protected settle(): Promise<void> {
        return new Promise((resolve) => {
            let quiet: ReturnType<typeof setTimeout>;
            const finish = () => {
                clearTimeout(quiet);
                clearTimeout(cap);
                unsubscribe();
                resolve();
            };
            const arm = () => {
                clearTimeout(quiet);
                quiet = setTimeout(finish, SETTLE_QUIET_MS);
            };
            const unsubscribe = (() => {
                const listener = () => arm();
                this.listeners.add(listener);
                return () => this.listeners.delete(listener);
            })();
            const cap = setTimeout(finish, SETTLE_MAX_MS);
            arm();
        });
    }

    protected async openStream(): Promise<string> {
        await this.ensureConnected();
        await this.settle();
        return this.buffer.join('');
    }

    onOutput(callback: (data: string) => void): () => void {
        this.listeners.add(callback);
        return () => {
            this.listeners.delete(callback);
        };
    }

    disconnect(): void {
        this.disposed = true;
        this.socket?.close();
        this.socket = null;
    }

    dispose(): void {
        this.disconnect();
        this.listeners.clear();
    }
}

export class DockerTerminal extends ProviderTerminal {
    private socket: RunnerSocket | null = null;
    private connecting: Promise<void> | null = null;
    private readonly listeners = new Set<(data: string) => void>();
    private readonly _id = `pty-${Math.random().toString(36).slice(2, 10)}`;

    constructor(
        private readonly client: RunnerClient,
        private readonly sandboxId: string,
    ) {
        super();
    }

    get id(): string {
        return this._id;
    }

    get name(): string {
        return 'bash';
    }

    private async connect(dimensions?: ProviderTerminalShellSize): Promise<RunnerSocket> {
        if (this.socket?.isOpen) return this.socket;
        if (!this.connecting) {
            const socket = new RunnerSocket(this.client, sandboxRoute(this.sandboxId, '/pty'), {
                cols: dimensions?.cols,
                rows: dimensions?.rows,
            });
            socket.onMessage((message) => {
                if (message.type === 'output' && typeof message.data === 'string') {
                    for (const listener of this.listeners) {
                        listener(message.data);
                    }
                }
            });
            socket.onClose(() => {
                if (this.socket === socket) this.socket = null;
            });
            this.connecting = socket
                .connect()
                .then(() => {
                    this.socket = socket;
                })
                .finally(() => {
                    this.connecting = null;
                });
        }
        await this.connecting;
        return this.socket as unknown as RunnerSocket;
    }

    async open(dimensions?: ProviderTerminalShellSize): Promise<string> {
        // Output is delivered through onOutput; nothing is buffered for pty sessions.
        await this.connect(dimensions);
        return '';
    }

    async write(input: string, dimensions?: ProviderTerminalShellSize): Promise<void> {
        const socket = await this.connect(dimensions);
        socket.send({ type: 'input', data: input });
    }

    async run(input: string, dimensions?: ProviderTerminalShellSize): Promise<void> {
        await this.write(`${input}\n`, dimensions);
    }

    resize(cols: number, rows: number): void {
        if (this.socket?.isOpen) {
            this.socket.send({ type: 'resize', cols, rows });
        }
    }

    async kill(): Promise<void> {
        this.dispose();
    }

    onOutput(callback: (data: string) => void): () => void {
        this.listeners.add(callback);
        return () => {
            this.listeners.delete(callback);
        };
    }

    dispose(): void {
        this.socket?.close();
        this.socket = null;
        this.listeners.clear();
    }
}

export class DockerTask extends ProviderTask {
    private readonly stream: DevTaskStream;

    constructor(client: RunnerClient, sandboxId: string, taskId: string) {
        super();
        this.stream = new DevTaskStream(client, sandboxId, taskId);
    }

    get id(): string {
        return this.stream.taskId;
    }

    get name(): string {
        return this.stream.taskId;
    }

    get command(): string {
        return this.stream.taskId;
    }

    open(): Promise<string> {
        return this.stream.open();
    }

    async run(): Promise<void> {
        await this.stream.open();
    }

    restart(): Promise<void> {
        return this.stream.restart();
    }

    async stop(): Promise<void> {
        this.stream.disconnect();
    }

    onOutput(callback: (data: string) => void): () => void {
        return this.stream.onOutput(callback);
    }

    dispose(): void {
        this.stream.dispose();
    }
}

class DevTaskStream extends DockerOutputStream {
    constructor(
        client: RunnerClient,
        private readonly sandboxId: string,
        readonly taskId: string,
    ) {
        super(client);
    }

    protected createSocket(): RunnerSocket {
        return new RunnerSocket(this.client, sandboxRoute(this.sandboxId, `/task/${this.taskId}`));
    }

    open(): Promise<string> {
        return this.openStream();
    }

    async restart(): Promise<void> {
        this.buffer = [];
        const socket = await this.ensureConnected();
        socket.send({ type: 'restart' });
        // The container restart ends the log stream; reattach so new logs keep flowing.
        const unsubscribe = socket.onClose(() => {
            unsubscribe();
            if (this.disposed) return;
            this.ensureConnected().catch((error) => {
                console.error('Failed to reattach to dev task logs', error);
            });
        });
    }
}

export class DockerBackgroundCommand extends ProviderBackgroundCommand {
    private readonly stream: BackgroundStream;

    constructor(
        client: RunnerClient,
        sandboxId: string,
        private readonly _command: string,
    ) {
        super();
        this.stream = new BackgroundStream(client, sandboxId, _command);
    }

    get name(): string | undefined {
        return undefined;
    }

    get command(): string {
        return this._command;
    }

    open(): Promise<string> {
        return this.stream.open();
    }

    async restart(): Promise<void> {
        await this.stream.kill();
        this.stream.reset();
        await this.stream.open();
    }

    kill(): Promise<void> {
        return this.stream.kill();
    }

    onOutput(callback: (data: string) => void): () => void {
        return this.stream.onOutput(callback);
    }

    dispose(): void {
        this.stream.dispose();
    }
}

class BackgroundStream extends DockerOutputStream {
    constructor(
        client: RunnerClient,
        private readonly sandboxId: string,
        private readonly command: string,
    ) {
        super(client);
    }

    protected createSocket(): RunnerSocket {
        return new RunnerSocket(this.client, sandboxRoute(this.sandboxId, '/bg'), {
            command: this.command,
        });
    }

    open(): Promise<string> {
        return this.openStream();
    }

    reset() {
        this.buffer = [];
    }

    async kill(): Promise<void> {
        if (this.socket?.isOpen) {
            this.socket.send({ type: 'kill' });
        }
        this.socket?.close();
        this.socket = null;
    }
}
