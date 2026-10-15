import fs from 'node:fs';
import path from 'node:path';
import { allocatePort, newSandboxId } from './ports.js';

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
        const parsed = JSON.parse(raw) as StateFile;
        for (const r of parsed.sandboxes ?? []) this.byId.set(r.id, r);
    }

    /** Atomic write: tmp file in the same dir, then rename over the state file. */
    flush() {
        const data: StateFile = { version: 1, sandboxes: [...this.byId.values()] };
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
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
