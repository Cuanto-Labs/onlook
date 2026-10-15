import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { allocatePort, ID_RE } from '../src/ports.js';
import { Registry } from '../src/state.js';
import { SECRET, tmpDir } from './helpers.js';

describe('port allocator + registry', () => {
    test('allocatePort picks lowest free, null when exhausted', () => {
        expect(allocatePort([], 4900, 4902)).toBe(4900);
        expect(allocatePort([4900, 4902], 4900, 4902)).toBe(4901);
        expect(allocatePort([4900, 4901, 4902], 4900, 4902)).toBeNull();
    });

    test('ids match the spec format and embed the port', () => {
        const dir = tmpDir();
        const reg = new Registry(dir, 4900, 4919);
        const rec = reg.create('t')!;
        expect(rec.id).toMatch(ID_RE);
        expect(rec.id.startsWith(`dk${rec.port}-`)).toBe(true);
        expect(rec.port).toBe(4900);
    });

    test('persists atomically and reloads', () => {
        const dir = tmpDir();
        const a = new Registry(dir, 4900, 4919);
        const r1 = a.create('one')!;
        const r2 = a.create()!;
        expect(fs.existsSync(path.join(dir, '.state.json'))).toBe(true);
        expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
        const b = new Registry(dir, 4900, 4919);
        expect(b.list().map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
        expect(b.get(r1.id)?.title).toBe('one');
        b.remove(r1.id);
        const c = new Registry(dir, 4900, 4919);
        expect(c.get(r1.id)).toBeUndefined();
        expect(c.create()!.port).toBe(r1.port); // freed port is reusable
    });

    test('touch persists on flushIfDirty', () => {
        const dir = tmpDir();
        const a = new Registry(dir, 4900, 4919);
        const r = a.create()!;
        a.touch(r.id, 12345);
        a.flushIfDirty();
        expect(new Registry(dir, 4900, 4919).get(r.id)?.lastActive).toBe(12345);
    });

    test('exhaustion returns null and ports stay unique', () => {
        const dir = tmpDir();
        const reg = new Registry(dir, 4900, 4902);
        const ports = [reg.create(), reg.create(), reg.create()].map((r) => r!.port);
        expect(new Set(ports).size).toBe(3);
        expect(reg.create()).toBeNull();
    });
});

describe('config', () => {
    test('requires a 32+ char secret and applies defaults', () => {
        expect(() => loadConfig({})).toThrow('RUNNER_SECRET');
        expect(() => loadConfig({ RUNNER_SECRET: 'short' })).toThrow('RUNNER_SECRET');
        const c = loadConfig({ RUNNER_SECRET: SECRET });
        expect(c).toMatchObject({
            host: '127.0.0.1', port: 3102, projectsDir: '/opt/onlook/projects', sandboxImage: 'onlook-sandbox:1',
            portMin: 4900, portMax: 4919, maxRunning: 4, idleMinutes: 30, sandboxMemMb: 1536, sandboxCpus: 2,
        });
    });

    test('rejects bad numbers and inverted port range', () => {
        expect(() => loadConfig({ RUNNER_SECRET: SECRET, RUNNER_PORT: 'abc' })).toThrow('RUNNER_PORT');
        expect(() => loadConfig({ RUNNER_SECRET: SECRET, PORT_MIN: '5000', PORT_MAX: '4000' })).toThrow('PORT_MAX');
    });
});
