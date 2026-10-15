import {
    CodeProvider,
    createCodeProviderClient,
    providerForSandboxId,
    type CodesandboxProviderOptions,
    type DockerSession,
    type Provider,
} from '@onlook/code-provider';

import { env } from '@/env';

type CodesandboxSession = NonNullable<
    Awaited<ReturnType<NonNullable<CodesandboxProviderOptions['getSession']>>>
>;

/** What `api.sandbox.start` returns: a CSB browser session or a runner token. */
export type SandboxStartResult = CodesandboxSession | (DockerSession & { runnerUrl: string });

function isRunnerSession(session: SandboxStartResult): session is DockerSession & {
    runnerUrl: string;
} {
    return 'token' in session && 'runnerUrl' in session;
}

export interface ConnectSandboxInput {
    sandboxId: string;
    userId?: string;
    /** Wraps `api.sandbox.start` for the caller's tRPC client. */
    startSession: (sandboxId: string) => Promise<SandboxStartResult>;
    keepActiveWhileConnected?: boolean;
}

/** Connects a provider for an existing sandbox, picking CSB or the self-hosted runner by id. */
export async function connectSandboxProvider({
    sandboxId,
    userId,
    startSession,
    keepActiveWhileConnected,
}: ConnectSandboxInput): Promise<Provider> {
    if (providerForSandboxId(sandboxId) === CodeProvider.Docker) {
        return createCodeProviderClient(CodeProvider.Docker, {
            providerOptions: {
                docker: {
                    sandboxId,
                    userId,
                    runnerUrl: env.NEXT_PUBLIC_RUNNER_URL ?? '',
                    getSession: async (id) => {
                        const session = await startSession(id);
                        if (!isRunnerSession(session)) {
                            throw new Error('Expected a runner session for a docker sandbox');
                        }
                        return session;
                    },
                },
            },
        });
    }
    return createCodeProviderClient(CodeProvider.CodeSandbox, {
        providerOptions: {
            codesandbox: {
                sandboxId,
                userId,
                initClient: true,
                keepActiveWhileConnected,
                getSession: async (id) => {
                    const session = await startSession(id);
                    if (isRunnerSession(session)) {
                        throw new Error('Expected a CodeSandbox session for a CSB sandbox');
                    }
                    return session;
                },
            },
        },
    });
}
