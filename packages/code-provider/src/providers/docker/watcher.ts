import { ProviderFileWatcher, type WatchEvent, type WatchFilesInput } from '../../types';
import { RunnerSocket, sandboxRoute, type RunnerClient } from './client';

export class DockerFileWatcher extends ProviderFileWatcher {
    private socket: RunnerSocket | null = null;
    private readonly callbacks = new Set<(event: WatchEvent) => Promise<void>>();
    private unsubscribe: (() => void) | null = null;

    constructor(
        private readonly client: RunnerClient,
        private readonly sandboxId: string,
    ) {
        super();
    }

    async start(input: WatchFilesInput): Promise<void> {
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
        this.unsubscribe = socket.onMessage((message) => {
            if (
                (message.type === 'add' || message.type === 'change' || message.type === 'remove') &&
                Array.isArray(message.paths)
            ) {
                const event: WatchEvent = {
                    type: message.type,
                    paths: message.paths as string[],
                };
                for (const callback of this.callbacks) {
                    callback(event).catch((error) => {
                        console.error('Error in file watcher callback', error);
                    });
                }
            }
        });
        await socket.connect();
        this.socket = socket;
    }

    registerEventCallback(callback: (event: WatchEvent) => Promise<void>): void {
        if (!this.socket) {
            throw new Error('Watcher not initialized');
        }
        this.callbacks.add(callback);
    }

    async stop(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.socket?.close();
        this.socket = null;
        this.callbacks.clear();
    }
}
