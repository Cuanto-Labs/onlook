import { ProviderFileWatcher, type WatchEvent, type WatchFilesInput } from '../../types';
import { RunnerSocket, sandboxRoute, type RunnerClient } from './client';

const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 5000;

export class DockerFileWatcher extends ProviderFileWatcher {
    private socket: RunnerSocket | null = null;
    private readonly callbacks = new Set<(event: WatchEvent) => Promise<void>>();
    private readonly unsubscribers: Array<() => void> = [];
    private input: WatchFilesInput | null = null;
    private stopped = false;
    private restartTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly client: RunnerClient,
        private readonly sandboxId: string,
        private readonly onStop?: () => void,
    ) {
        super();
    }

    private detach() {
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers.length = 0;
        this.socket?.close();
        this.socket = null;
    }

    private dispatch(event: WatchEvent) {
        for (const callback of this.callbacks) {
            callback(event).catch((error) => {
                console.error('Error in file watcher callback', error);
            });
        }
    }

    async start(input: WatchFilesInput): Promise<void> {
        // A second start() replaces the previous socket instead of leaking it.
        this.detach();
        this.stopped = false;
        this.input = input;
        await this.open(input);
    }

    private async open(input: WatchFilesInput): Promise<void> {
        const socket = new RunnerSocket(
            this.client,
            sandboxRoute(this.sandboxId, '/watch'),
            {
                path: input.args.path,
                recursive: input.args.recursive ?? false,
                excludes: (input.args.excludes ?? []).join(','),
            },
            { reconnect: true },
        );
        this.unsubscribers.push(
            socket.onMessage((message) => {
                if (
                    (message.type === 'add' ||
                        message.type === 'change' ||
                        message.type === 'remove') &&
                    Array.isArray(message.paths)
                ) {
                    // The runner batches events; consumers treat a 2-path `change` as a rename,
                    // so always emit exactly one event per path.
                    for (const path of message.paths as string[]) {
                        this.dispatch({ type: message.type, paths: [path] });
                    }
                }
            }),
            socket.onGiveUp(() => this.scheduleRestart(0)),
        );
        await socket.connect();
        this.socket = socket;
    }

    private scheduleRestart(attempt: number) {
        if (this.stopped || !this.input) return;
        if (attempt >= MAX_RESTARTS) {
            console.error(
                `File watcher for ${this.sandboxId} lost its connection and could not be restored`,
            );
            return;
        }
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.stopped || !this.input) return;
            const input = this.input;
            this.detach();
            this.open(input).catch((error) => {
                console.error('Failed to restart file watcher', error);
                this.detach();
                this.scheduleRestart(attempt + 1);
            });
        }, RESTART_DELAY_MS);
    }

    registerEventCallback(callback: (event: WatchEvent) => Promise<void>): void {
        if (!this.socket) {
            throw new Error('Watcher not initialized');
        }
        this.callbacks.add(callback);
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        this.detach();
        this.input = null;
        this.callbacks.clear();
        this.onStop?.();
    }
}
