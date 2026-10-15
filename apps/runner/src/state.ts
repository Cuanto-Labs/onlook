import fs from 'node:fs';
import path from 'node:path';
import { allocatePort, isValidId, newSandboxId } from './ports.js';

export interface SandboxRecord {
    id: string;
    port: number;
    title?: string;
    createdAt: number;
    /** ms epoch */
    lastActive: number;
}

interface StateFile {
    version: 1;
    sandboxes: SandboxRecord[];
}

/**
 * Accept only well-formed records: the id is used to build host paths and container names, so a corrupt or
 * tampered state file must not be able to smuggle `../` or odd characters through.
 */
export function validRecord(r: unknown): SandboxRecord | null {
    if (typeof r !== 'object' || r === null) return null;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || !isValidId(o.id)) return null;
    if (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535) return null;
    if (!o.id.startsWith(`dk${o.port}-`)) return null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const createdAt = num(o.createdAt);
    const lastActive = num(o.lastActive);
    if (createdAt === null || lastActive === null) return null;
    const rec: SandboxRecord = { id: o.id, port: o.port, createdAt, lastActive };
    if (typeof o.title === 'string') rec.title = o.title;
    return rec;
}

/** Sandbox registry + port allocator, persisted atomically (tmp + rename) to `<projectsDir>/.state.json`. */
export class Registry {
    private readonly byId = new Map<string, SandboxRecord>();
    private dirty = false;
    readonly file: string;

    constructor(
        projectsDir: string,
        private readonly portMin: number,
        private readonly portMax: number,
    ) {
        this.file = path.join(projectsDir, '.state.json');
        fs.mkdirSync(projectsDir, { recursive: true });
        // Root-owned, traversable (so sandbox uids can reach their own 0700 subdir) but not listable.
        if (process.getuid?.() === 0) fs.chownSync(projectsDir, 0, 0);
        fs.chmodSync(projectsDir, 0o711);
        this.load();
    }

    private load() {
        let raw: string;
        try {
            raw = fs.readFileSync(this.file, 'utf8');
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw e;
        }
        const parsed = JSON.parse(raw) as Partial<StateFile>;
        const list: unknown[] = Array.isArray(parsed.sandboxes) ? parsed.sandboxes : [];
        for (const r of list) {
            const rec = validRecord(r);
            // one sandbox per port: the port also fixes the sandbox's uid
            if (rec && ![...this.byId.values()].some((x) => x.port === rec.port)) this.byId.set(rec.id, rec);
            else console.warn('[state] dropped invalid sandbox record');
        }
        try {
            fs.chmodSync(this.file, 0o600);
        } catch {
            // best effort; flush() rewrites with 0600 anyway
        }
    }

    /** Atomic write: tmp file in the same dir, then rename over the state file. */
    flush() {
        const data: StateFile = { version: 1, sandboxes: [...this.byId.values()] };
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
        this.dirty = false;
    }

    /** Persist pending lastActive bumps. */
    flushIfDirty() {
        if (this.dirty) this.flush();
    }

    /** Allocates a port + id and persists. Null when no port is free. */
    create(title?: string): SandboxRecord | null {
        const port = allocatePort([...this.byId.values()].map((r) => r.port), this.portMin, this.portMax);
        if (port === null) return null;
        let id = newSandboxId(port);
        while (this.byId.has(id)) id = newSandboxId(port);
        const now = Date.now();
        const rec: SandboxRecord = { id, port, createdAt: now, lastActive: now };
        if (title) rec.title = title;
        this.byId.set(id, rec);
        this.flush();
        return rec;
    }

    get(id: string): SandboxRecord | undefined {
        return this.byId.get(id);
    }

    list(): SandboxRecord[] {
        return [...this.byId.values()];
    }

    remove(id: string): boolean {
        const had = this.byId.delete(id);
        if (had) this.flush();
        return had;
    }

    touch(id: string, now = Date.now()) {
        const r = this.byId.get(id);
        if (!r) return;
        r.lastActive = now;
        this.dirty = true;
    }
}
