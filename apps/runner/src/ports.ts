import { randomInt } from 'node:crypto';

export const ID_RE = /^dk(\d{4,5})-[a-z0-9]{6}$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const isValidId = (id: string) => ID_RE.test(id);

/** Lowest free port in [min, max], or null when exhausted. */
export function allocatePort(used: Iterable<number>, min: number, max: number): number | null {
    const taken = new Set(used);
    for (let p = min; p <= max; p++) if (!taken.has(p)) return p;
    return null;
}

export function newSandboxId(port: number): string {
    let suffix = '';
    for (let i = 0; i < 6; i++) suffix += ALPHABET[randomInt(ALPHABET.length)];
    return `dk${port}-${suffix}`;
}
