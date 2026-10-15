import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startWatch, type WatchBatch } from '../src/watch.js';
import { tmpDir } from './helpers.js';

describe('watch', () => {
    test('emits batched root-relative events and ignores node_modules/.git/excludes', async () => {
        const root = tmpDir();
        fs.mkdirSync(path.join(root, 'src'));
        fs.mkdirSync(path.join(root, 'node_modules'));
        fs.mkdirSync(path.join(root, 'skipme'));
        fs.writeFileSync(path.join(root, 'src', 'a.txt'), '1');
        const batches: WatchBatch[] = [];
        const close = await startWatch(root, '', { recursive: true, excludes: ['skipme'] }, (b) => batches.push(b));
        fs.writeFileSync(path.join(root, 'src', 'b.txt'), 'new');
        fs.writeFileSync(path.join(root, 'src', 'a.txt'), '2');
        fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'x');
        fs.writeFileSync(path.join(root, 'skipme', 'ignored.js'), 'x');
        await new Promise((r) => setTimeout(r, 800));
        fs.rmSync(path.join(root, 'src', 'b.txt'));
        await new Promise((r) => setTimeout(r, 800));
        await close();
        const all = batches.flatMap((b) => b.paths.map((p) => `${b.type}:${p}`));
        expect(all).toContain('add:src/b.txt');
        expect(all).toContain('change:src/a.txt');
        expect(all).toContain('remove:src/b.txt');
        expect(all.some((e) => e.includes('node_modules') || e.includes('skipme'))).toBe(false);
    });
});
