/**
 * Runner auth tokens. Format (deploy/cuanto/runner/API.md):
 *   base64url(JSON payload) + '.' + base64url(HMAC-SHA256(RUNNER_SECRET, payloadPart))
 *
 * Signing uses WebCrypto (`globalThis.crypto.subtle`, present in Node 22, Bun and browsers) so the
 * module bundles for the client without pulling in `node:crypto`. Only call the minting helpers on
 * the server: they read `RUNNER_SECRET` from `process.env`.
 */

export interface RunnerTokenPayload {
    sid: string;
    uid: string;
    exp: number;
}

export const SANDBOX_TOKEN_TTL_SECONDS = 12 * 60 * 60;
export const ADMIN_TOKEN_TTL_SECONDS = 5 * 60;

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signRunnerToken(
    secret: string,
    payload: RunnerTokenPayload,
): Promise<string> {
    const encoder = new TextEncoder();
    const payloadPart = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
    const key = await globalThis.crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(payloadPart));
    return `${payloadPart}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export interface RunnerServerConfig {
    url: string;
    secret: string;
}

/** Server-only: runner URL + secret from the environment. */
export function getRunnerServerConfig(): RunnerServerConfig {
    if (typeof window !== 'undefined') {
        throw new Error('Runner admin access is only available on the server');
    }
    const url = process.env.RUNNER_INTERNAL_URL;
    const secret = process.env.RUNNER_SECRET;
    if (!url || !secret) {
        throw new Error('RUNNER_INTERNAL_URL and RUNNER_SECRET must be set');
    }
    return { url, secret };
}

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

/** Server-only: per-sandbox token (valid only for routes under /sandboxes/<sandboxId>/). */
export async function mintSandboxToken(
    sandboxId: string,
    userId: string,
    ttlSeconds: number = SANDBOX_TOKEN_TTL_SECONDS,
): Promise<string> {
    const { secret } = getRunnerServerConfig();
    return signRunnerToken(secret, {
        sid: sandboxId,
        uid: userId,
        exp: nowSeconds() + ttlSeconds,
    });
}

/** Server-only: admin token (sid '*'), short-lived. */
export async function mintAdminToken(
    ttlSeconds: number = ADMIN_TOKEN_TTL_SECONDS,
): Promise<string> {
    const { secret } = getRunnerServerConfig();
    return signRunnerToken(secret, { sid: '*', uid: 'server', exp: nowSeconds() + ttlSeconds });
}
