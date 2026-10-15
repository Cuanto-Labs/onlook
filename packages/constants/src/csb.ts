import type { SandboxTemplate } from '@onlook/models';

export enum Templates {
    BLANK = 'BLANK',
    EMPTY_NEXTJS = 'EMPTY_NEXTJS',
}

export const SandboxTemplates: Record<Templates, SandboxTemplate> = {
    BLANK: {
        id: 'xzsy8c',
        port: 3000,
    },
    EMPTY_NEXTJS: {
        id: 'pt_EphPmsurimGCQdiB44wa7s',
        port: 3000,
    },
};

export const CSB_PREVIEW_TASK_NAME = 'dev';
export const CSB_DOMAIN = 'csb.app';

const DOCKER_SANDBOX_ID = /^dk(\d{4,5})-[a-z0-9]{6}$/;

export function getSandboxPreviewUrl(sandboxId: string, port: number) {
    // Self-hosted runner: the host port is encoded in the id, the requested port is the container's.
    const dockerMatch = DOCKER_SANDBOX_ID.exec(sandboxId);
    if (dockerMatch) {
        // Literal reference so Next inlines NEXT_PUBLIC_* into client bundles.
        return `https://${process.env.NEXT_PUBLIC_SANDBOX_PREVIEW_HOST}:${dockerMatch[1]}`;
    }
    return `https://${sandboxId}-${port}.${CSB_DOMAIN}`;
}
