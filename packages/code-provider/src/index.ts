import { CodeProvider } from './providers';
import { CodesandboxProvider, type CodesandboxProviderOptions } from './providers/codesandbox';
import {
    DockerProvider,
    isDockerSandboxId,
    type DockerProviderOptions,
} from './providers/docker';
import { NodeFsProvider, type NodeFsProviderOptions } from './providers/nodefs';
export * from './providers';
export { CodesandboxProvider, type CodesandboxProviderOptions } from './providers/codesandbox';
export {
    DockerProvider,
    dockerPortFromId,
    isDockerSandboxId,
    type DockerProviderOptions,
    type DockerSession,
} from './providers/docker';
export { mintAdminToken, mintSandboxToken, signRunnerToken } from './providers/docker/token';
export { NodeFsProvider } from './providers/nodefs';
export * from './types';

/** Docker ids (`dk<port>-<6 chars>`) belong to the self-hosted runner; everything else is CSB. */
export function providerForSandboxId(sandboxId: string): CodeProvider {
    return isDockerSandboxId(sandboxId) ? CodeProvider.Docker : CodeProvider.CodeSandbox;
}

/** Provider used when creating new sandboxes. Reads NEXT_PUBLIC_CODE_PROVIDER ('docker' or default CSB). */
export function defaultCodeProvider(): CodeProvider {
    return process.env.NEXT_PUBLIC_CODE_PROVIDER === 'docker'
        ? CodeProvider.Docker
        : CodeProvider.CodeSandbox;
}

export interface CreateClientOptions {
    providerOptions: ProviderInstanceOptions;
}

/**
 * Providers are designed to be singletons; be mindful of this when creating multiple clients
 * or when instantiating in the backend (stateless vs stateful).
 */
export async function createCodeProviderClient(
    codeProvider: CodeProvider,
    { providerOptions }: CreateClientOptions,
) {
    const provider = newProviderInstance(codeProvider, providerOptions);
    await provider.initialize({});
    return provider;
}

export async function getStaticCodeProvider(
    codeProvider: CodeProvider,
): Promise<typeof CodesandboxProvider | typeof NodeFsProvider | typeof DockerProvider> {
    if (codeProvider === CodeProvider.CodeSandbox) {
        return CodesandboxProvider;
    }

    if (codeProvider === CodeProvider.Docker) {
        return DockerProvider;
    }

    if (codeProvider === CodeProvider.NodeFs) {
        return NodeFsProvider;
    }
    throw new Error(`Unimplemented code provider: ${codeProvider}`);
}

export interface ProviderInstanceOptions {
    codesandbox?: CodesandboxProviderOptions;
    nodefs?: NodeFsProviderOptions;
    docker?: DockerProviderOptions;
}

function newProviderInstance(codeProvider: CodeProvider, providerOptions: ProviderInstanceOptions) {
    if (codeProvider === CodeProvider.CodeSandbox) {
        if (!providerOptions.codesandbox) {
            throw new Error('Codesandbox provider options are required.');
        }
        return new CodesandboxProvider(providerOptions.codesandbox);
    }

    if (codeProvider === CodeProvider.Docker) {
        if (!providerOptions.docker) {
            throw new Error('Docker provider options are required.');
        }
        return new DockerProvider(providerOptions.docker);
    }

    if (codeProvider === CodeProvider.NodeFs) {
        if (!providerOptions.nodefs) {
            throw new Error('NodeFs provider options are required.');
        }
        return new NodeFsProvider(providerOptions.nodefs);
    }

    throw new Error(`Unimplemented code provider: ${codeProvider}`);
}
