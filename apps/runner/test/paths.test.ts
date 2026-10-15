import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSafe, stripPrefix } from '../src/paths.js';
import { tmpDir } from './helpers.js';

describe('paths', () => {
    const root = tmpDir();
    const outside = tmpDir('runner-outside-');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
    fs.symlinkSync(outside, path.join(root, 'escape-dir'));
    fs.symlinkSync(path.join(outside, 'nope'), path.join(root, 'dangling'));
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'inner-link'));

    test('strips leading slash, ./ and /project/workspace/', () => {
        expect(stripPrefix('/src/a.ts')).toBe('src/a.ts');
        expect(stripPrefix('./src/a.ts')).toBe('src/a.ts');
        expect(stripPrefix('/project/workspace/src/a.ts')).toBe('src/a.ts');
        expect(stripPrefix('/project/workspace')).toBe('');
        expect(stripPrefix('.')).toBe('');
    });

    test('resolves normal paths inside root', async () => {
        expect(await resolveSafe(root, 'src/a.ts')).toBe(path.join(root, 'src/a.ts'));
        expect(await resolveSafe(root, '/project/workspace/src/a.ts')).toBe(path.join(root, 'src/a.ts'));
        expect(await resolveSafe(root, 'new/dir/file.txt')).toBe(path.join(root, 'new/dir/file.txt'));
        expect(await resolveSafe(root, '')).toBe(root);
        expect(await resolveSafe(root, 'src/../src/a.ts')).toBe(path.join(root, 'src/a.ts'));
    });

    test('absolute paths are re-rooted, not escaped', async () => {
        expect(await resolveSafe(root, '/etc/passwd')).toBe(path.join(root, 'etc/passwd'));
    });

    test('rejects .. traversal', async () => {
        for (const p of ['..', '../x', 'src/../../x', '/../x', './../x', '/project/workspace/../x', 'a/../../b']) {
            await expect(resolveSafe(root, p)).rejects.toThrow('invalid path');
        }
    });

    test('rejects NUL bytes', async () => {
        await expect(resolveSafe(root, 'a\0b')).rejects.toThrow('invalid path');
    });

    test('rejects symlink escapes (dir, child of link, new file under link, dangling)', async () => {
        await expect(resolveSafe(root, 'escape-dir')).rejects.toThrow('invalid path');
        await expect(resolveSafe(root, 'escape-dir/secret.txt')).rejects.toThrow('invalid path');
        await expect(resolveSafe(root, 'escape-dir/new/file.txt')).rejects.toThrow('invalid path');
        await expect(resolveSafe(root, 'dangling')).rejects.toThrow('invalid path');
    });

    test('allows symlinks that stay inside root', async () => {
        expect(await resolveSafe(root, 'inner-link/a.ts')).toBe(path.join(root, 'inner-link/a.ts'));
    });

    test('followFinal:false lets a link be addressed itself', async () => {
        expect(await resolveSafe(root, 'escape-dir', { followFinal: false })).toBe(path.join(root, 'escape-dir'));
        await expect(resolveSafe(root, 'escape-dir/x', { followFinal: false })).rejects.toThrow('invalid path');
    });
});
