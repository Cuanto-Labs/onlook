import { convertToBase64 } from '@onlook/utility';
import {
    Provider,
    type CopyFileOutput,
    type CopyFilesInput,
    type CreateDirectoryInput,
    type CreateDirectoryOutput,
    type CreateProjectInput,
    type CreateProjectOutput,
    type CreateSessionInput,
    type CreateSessionOutput,
    type CreateTerminalInput,
    type CreateTerminalOutput,
    type DeleteFilesInput,
    type DeleteFilesOutput,
    type DownloadFilesInput,
    type DownloadFilesOutput,
    type GetTaskInput,
    type GetTaskOutput,
    type GitStatusInput,
    type GitStatusOutput,
    type InitializeInput,
    type InitializeOutput,
    type ListFilesInput,
    type ListFilesOutput,
    type ListProjectsInput,
    type ListProjectsOutput,
    type PauseProjectInput,
    type PauseProjectOutput,
    type ReadFileInput,
    type ReadFileOutput,
    type RenameFileInput,
    type RenameFileOutput,
    type SetupInput,
    type SetupOutput,
    type StatFileInput,
    type StatFileOutput,
    type StopProjectInput,
    type StopProjectOutput,
    type TerminalBackgroundCommandInput,
    type TerminalBackgroundCommandOutput,
    type TerminalCommandInput,
    type TerminalCommandOutput,
    type WatchFilesInput,
    type WatchFilesOutput,
    type WriteFileInput,
    type WriteFileOutput,
} from '../../types';
import {
    RunnerClient,
    base64ToBytes,
    bytesToBase64,
    sandboxRoute,
} from './client';
import { DockerBackgroundCommand, DockerTask, DockerTerminal } from './terminal';
import { getRunnerServerConfig, mintAdminToken, mintSandboxToken } from './token';
import { DockerFileWatcher } from './watcher';

export { RunnerClient, RunnerError, RunnerSocket } from './client';
export { mintAdminToken, mintSandboxToken, signRunnerToken } from './token';
export type { RunnerTokenPayload } from './token';

const DOCKER_SANDBOX_ID = /^dk(\d{4,5})-[a-z0-9]{6}$/;
const KEEPALIVE_MS = 60_000;

export function isDockerSandboxId(id: string | null | undefined): boolean {
    return !!id && DOCKER_SANDBOX_ID.test(id);
}

/** Preview port allocated by the runner, encoded in the sandbox id. */
export function dockerPortFromId(id: string): number | null {
    const match = DOCKER_SANDBOX_ID.exec(id);
    return match?.[1] ? parseInt(match[1], 10) : null;
}

export interface DockerSession {
    token: string;
    runnerUrl?: string;
}

export interface DockerProviderOptions {
    sandboxId: string;
    userId?: string;
    runnerUrl: string;
    /** Browser path: fetches a per-sandbox token from the onlook-web server. */
    getSession?: (sandboxId: string, userId?: string) => Promise<DockerSession>;
    token?: string;
}

export interface DockerCreateSessionOutput extends CreateSessionOutput, DockerSession {}

export class DockerProvider extends Provider {
    private readonly options: DockerProviderOptions;
    private client: RunnerClient;
    private keepalive: ReturnType<typeof setInterval> | null = null;
    private readonly watchers = new Set<DockerFileWatcher>();
    private readonly terminals = new Set<DockerTerminal>();
    private readonly tasks = new Map<string, DockerTask>();
    private readonly commands = new Set<DockerBackgroundCommand>();

    constructor(options: DockerProviderOptions) {
        super();
        this.options = options;
        this.client = this.newClient(options.runnerUrl, options.token);
    }

    private newClient(baseUrl: string, token?: string) {
        return new RunnerClient({
            baseUrl,
            token,
            refreshToken: async () => {
                try {
                    return await this.fetchToken();
                } catch {
                    return undefined;
                }
            },
        });
    }

    private get sandboxId() {
        return this.options.sandboxId;
    }

    private route(rest = '') {
        return sandboxRoute(this.sandboxId, rest);
    }

    /** Obtains a token through getSession (browser) or by signing one (server). */
    private async fetchToken(): Promise<string | undefined> {
        if (this.options.getSession) {
            const session = await this.options.getSession(this.sandboxId, this.options.userId);
            if (session.runnerUrl && session.runnerUrl !== this.options.runnerUrl) {
                this.options.runnerUrl = session.runnerUrl;
                this.client = this.newClient(session.runnerUrl);
            }
            return session.token;
        }
        if (typeof window === 'undefined') {
            return mintSandboxToken(this.sandboxId, this.options.userId ?? 'server');
        }
        return undefined;
    }

    async initialize(input: InitializeInput): Promise<InitializeOutput> {
        if (!this.sandboxId) {
            return {};
        }
        if (!this.client.getToken()) {
            const token = await this.fetchToken();
            if (!token) {
                throw new Error('Docker provider requires a token or getSession');
            }
            this.client.setToken(token);
        }
        await this.client.request('POST', this.route('/start'));
        this.startKeepalive();
        return {};
    }

    private startKeepalive() {
        this.stopKeepalive();
        this.keepalive = setInterval(() => {
            this.client.request('POST', this.route('/ping')).catch((error) => {
                console.warn('Failed to ping sandbox', error);
            });
        }, KEEPALIVE_MS);
        // Do not hold a Node process open just for the keepalive.
        (this.keepalive as { unref?: () => void }).unref?.();
    }

    private stopKeepalive() {
        if (this.keepalive) {
            clearInterval(this.keepalive);
            this.keepalive = null;
        }
    }

    async reload(): Promise<boolean> {
        const { task } = await this.getTask({ args: { id: 'dev' } });
        await task.restart();
        return true;
    }

    async reconnect(): Promise<void> {
        // Sockets are opened per feature on demand; nothing to restore here.
    }

    async ping(): Promise<boolean> {
        try {
            await this.client.request('GET', '/health', { parse: 'text' });
            return true;
        } catch (error) {
            console.error('Failed to ping sandbox', error);
            return false;
        }
    }

    async destroy(): Promise<void> {
        this.stopKeepalive();
        for (const watcher of this.watchers) await watcher.stop();
        for (const terminal of this.terminals) terminal.dispose();
        for (const task of this.tasks.values()) task.dispose();
        for (const command of this.commands) command.dispose();
        this.watchers.clear();
        this.terminals.clear();
        this.tasks.clear();
        this.commands.clear();
    }

    // ---- server-side statics (admin token) ----

    private static async adminClient(): Promise<RunnerClient> {
        const { url } = getRunnerServerConfig();
        return new RunnerClient({ baseUrl: url, token: await mintAdminToken() });
    }

    static async createProject(input: CreateProjectInput): Promise<CreateProjectOutput> {
        const client = await DockerProvider.adminClient();
        const fromId = [input.source, input.id].find((candidate) => isDockerSandboxId(candidate));
        const res = await client.request<{ id: string; port: number }>('POST', '/sandboxes', {
            body: { fromId, title: input.title },
        });
        return { id: res.id };
    }

    static async createProjectFromGit(input: {
        repoUrl: string;
        branch: string;
    }): Promise<CreateProjectOutput> {
        throw new Error('GitHub import is not available on the self-hosted runner');
    }

    static async startSandbox(sandboxId: string): Promise<void> {
        const client = await DockerProvider.adminClient();
        await client.request('POST', sandboxRoute(sandboxId, '/start'));
    }

    static async stopSandbox(sandboxId: string): Promise<void> {
        const client = await DockerProvider.adminClient();
        await client.request('POST', sandboxRoute(sandboxId, '/stop'));
    }

    static async deleteSandbox(sandboxId: string): Promise<void> {
        const client = await DockerProvider.adminClient();
        await client.request('DELETE', sandboxRoute(sandboxId));
    }

    // ---- project lifecycle (per-sandbox token) ----

    async pauseProject(input: PauseProjectInput): Promise<PauseProjectOutput> {
        await this.client.request('POST', this.route('/stop'));
        return {};
    }

    async stopProject(input: StopProjectInput): Promise<StopProjectOutput> {
        await this.client.request('POST', this.route('/stop'));
        return {};
    }

    async listProjects(input: ListProjectsInput): Promise<ListProjectsOutput> {
        // Listing is admin-only on the runner and the app scopes lists per user; nothing to return.
        return { projects: [] };
    }

    // ---- files ----

    async writeFile({ args }: WriteFileInput): Promise<WriteFileOutput> {
        try {
            const isText = typeof args.content === 'string';
            if (!isText && !(args.content instanceof Uint8Array)) {
                throw new Error(`Invalid content type ${typeof args.content}`);
            }
            await this.client.request('PUT', this.route('/fs/write'), {
                body: {
                    path: args.path,
                    content: isText ? args.content : bytesToBase64(args.content as Uint8Array),
                    encoding: isText ? 'utf8' : 'base64',
                    ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
                },
            });
            return { success: true };
        } catch (error) {
            console.error(`Error writing remote file ${args.path}:`, error);
            return { success: false };
        }
    }

    async renameFile({ args }: RenameFileInput): Promise<RenameFileOutput> {
        await this.client.request('POST', this.route('/fs/rename'), {
            body: { oldPath: args.oldPath, newPath: args.newPath },
        });
        return {};
    }

    async statFile({ args }: StatFileInput): Promise<StatFileOutput> {
        const res = await this.client.request<StatFileOutput>('GET', this.route('/fs/stat'), {
            query: { path: args.path },
        });
        return {
            type: res.type,
            isSymlink: res.isSymlink,
            size: res.size,
            mtime: res.mtime,
            ctime: res.ctime,
            atime: res.atime,
        };
    }

    async deleteFiles({ args }: DeleteFilesInput): Promise<DeleteFilesOutput> {
        await this.client.request('DELETE', this.route('/fs'), {
            query: { path: args.path, recursive: args.recursive ?? false },
        });
        return {};
    }

    async listFiles({ args }: ListFilesInput): Promise<ListFilesOutput> {
        const res = await this.client.request<ListFilesOutput>('GET', this.route('/fs/list'), {
            query: { path: args.path },
        });
        return {
            files: res.files.map((file) => ({
                name: file.name,
                type: file.type,
                isSymlink: file.isSymlink,
            })),
        };
    }

    async readFile({ args }: ReadFileInput): Promise<ReadFileOutput> {
        let res: { type: 'text' | 'binary'; content: string };
        try {
            res = await this.client.request('GET', this.route('/fs/read'), {
                query: { path: args.path },
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to read file ${args.path}: ${reason}`);
        }
        if (res.type === 'text') {
            const content = res.content;
            return {
                file: { path: args.path, type: 'text', content, toString: () => content },
            };
        }
        const content = base64ToBytes(res.content);
        return {
            file: {
                path: args.path,
                type: 'binary',
                content,
                toString: () => convertToBase64(content),
            },
        };
    }

    async downloadFiles(input: DownloadFilesInput): Promise<DownloadFilesOutput> {
        // The runner authenticates downloads with a Bearer header, which a plain URL cannot carry.
        return { url: undefined };
    }

    async copyFiles({ args }: CopyFilesInput): Promise<CopyFileOutput> {
        await this.client.request('POST', this.route('/fs/copy'), {
            body: {
                sourcePath: args.sourcePath,
                targetPath: args.targetPath,
                recursive: args.recursive,
                overwrite: args.overwrite,
            },
        });
        return {};
    }

    async createDirectory({ args }: CreateDirectoryInput): Promise<CreateDirectoryOutput> {
        await this.client.request('POST', this.route('/fs/mkdir'), { body: { path: args.path } });
        return {};
    }

    async watchFiles(input: WatchFilesInput): Promise<WatchFilesOutput> {
        const watcher = new DockerFileWatcher(this.client, this.sandboxId);
        await watcher.start(input);
        this.watchers.add(watcher);

        if (input.onFileChange) {
            watcher.registerEventCallback(async (event) => {
                if (input.onFileChange) {
                    await input.onFileChange({ type: event.type, paths: event.paths });
                }
            });
        }
        return { watcher };
    }

    // ---- terminals, tasks, commands ----

    async createTerminal(input: CreateTerminalInput): Promise<CreateTerminalOutput> {
        const terminal = new DockerTerminal(this.client, this.sandboxId);
        this.terminals.add(terminal);
        return { terminal };
    }

    async getTask({ args }: GetTaskInput): Promise<GetTaskOutput> {
        if (args.id !== 'dev') {
            throw new Error(`Task ${args.id} not found`);
        }
        let task = this.tasks.get(args.id);
        if (!task) {
            task = new DockerTask(this.client, this.sandboxId, args.id);
            this.tasks.set(args.id, task);
        }
        return { task };
    }

    async runCommand({ args }: TerminalCommandInput): Promise<TerminalCommandOutput> {
        const res = await this.client.request<{ output: string; exitCode: number }>(
            'POST',
            this.route('/exec'),
            { body: { command: args.command } },
        );
        return { output: res.output };
    }

    async runBackgroundCommand({
        args,
    }: TerminalBackgroundCommandInput): Promise<TerminalBackgroundCommandOutput> {
        const command = new DockerBackgroundCommand(this.client, this.sandboxId, args.command);
        this.commands.add(command);
        return { command };
    }

    async gitStatus(input: GitStatusInput): Promise<GitStatusOutput> {
        const res = await this.client.request<{ changedFiles: string[] }>(
            'GET',
            this.route('/git-status'),
        );
        return { changedFiles: res.changedFiles };
    }

    async setup(input: SetupInput): Promise<SetupOutput> {
        // The runner image ships with dependencies installed and starts the dev server itself.
        return {};
    }

    /** Returns the data the browser needs to talk to the runner. Server-side only. */
    async createSession(input: CreateSessionInput): Promise<DockerCreateSessionOutput> {
        const token = await mintSandboxToken(this.sandboxId, this.options.userId ?? input.args.id);
        return { token, runnerUrl: this.options.runnerUrl };
    }
}
