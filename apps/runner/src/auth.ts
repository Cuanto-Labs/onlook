import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenPayload {
    /** Sandbox id, or "*" for an admin token. */
    sid: string;
    uid: string;
    /** Unix seconds. */
    exp: number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function mac(part: string, secret: string): Buffer {
    return createHmac('sha256', secret).update(part).digest();
}

/** token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payloadPart)) */
export function signToken(payload: TokenPayload, secret: string): string {
    const part = b64url(JSON.stringify(payload));
    return `${part}.${b64url(mac(part, secret))}`;
}

/** Returns the payload when signature + expiry are valid, else null. */
export function verifyToken(
    token: string,
    secret: string,
    nowSec: number = Math.floor(Date.now() / 1000),
): TokenPayload | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [part, sig] = parts as [string, string];
    const given = Buffer.from(sig, 'base64url');
    const expected = mac(part, secret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let p: unknown;
    try {
        p = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (typeof p !== 'object' || p === null) return null;
    const { sid, uid, exp } = p as Record<string, unknown>;
    if (typeof sid !== 'string' || typeof uid !== 'string' || typeof exp !== 'number') return null;
    if (!(exp > nowSec)) return null;
    return { sid, uid, exp };
}

export const isAdmin = (p: TokenPayload) => p.sid === '*';

/** Admin tokens may touch any sandbox; others only their own. */
export const canAccess = (p: TokenPayload, sandboxId: string) => isAdmin(p) || p.sid === sandboxId;

export function bearerToken(header: string | undefined | null): string | null {
    if (!header) return null;
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    return m ? m[1]! : null;
}
