import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

/** True when the runner can change ownership / drop privileges (root in its container). */
export const isRoot = (): boolean => process.getuid?.() === 0;

/**
 * Hand a project dir to its sandbox identity: mode 0700 first (so nobody else can enter while it is
 * being re-owned), then `chown -R -h` (never follows symlinks). Ownership part is a no-op unless root.
 */
export async function lockProjectDir(dir: string, uid: number, gid: number): Promise<void> {
    await fs.chmod(dir, 0o700);
    if (!isRoot()) return;
    await new Promise<void>((resolve, reject) =>
        execFile('chown', ['-R', '-h', `${uid}:${gid}`, '--', dir], (err) => (err ? reject(err) : resolve())),
    );
}
