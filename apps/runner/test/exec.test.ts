import { describe, expect, test } from 'bun:test';
import { buildBgCommand, clampTimeout, parsePorcelainZ, shQuote, wrapShell } from '../src/exec.js';

describe('exec helpers', () => {
    test('shQuote handles single quotes', () => {
        expect(shQuote("it's")).toBe(`'it'\\''s'`);
    });

    test('timeout clamp', () => {
        expect(clampTimeout(undefined)).toBe(120_000);
        expect(clampTimeout(5000)).toBe(5000);
        expect(clampTimeout(9_999_999)).toBe(600_000);
        expect(clampTimeout(-1)).toBe(120_000);
    });

    test('wrapShell uses timeout + sh -lc', () => {
        expect(wrapShell('ls', 1500)).toEqual(['timeout', '-k', '5', '2', 'sh', '-lc', 'ls']);
    });

    test('parsePorcelainZ: modified, untracked, rename, copy', () => {
        expect(parsePorcelainZ('')).toEqual([]);
        expect(parsePorcelainZ(' M a.ts\0?? b c.ts\0R  new.ts\0old.ts\0A  z.ts\0')).toEqual([
            'a.ts', 'b c.ts', 'new.ts', 'z.ts',
        ]);
    });

    test('bg command records pid then execs the command', () => {
        const bg = buildBgCommand("echo 'a' && sleep 1", 'u1');
        expect(bg.pidFile).toBe('/tmp/bg-u1.pid');
        expect(bg.cmd.slice(0, 2)).toEqual(['sh', '-lc']);
        expect(bg.cmd[2]).toStartWith('echo $$ > /tmp/bg-u1.pid; exec sh -c ');
        expect(bg.killScript).toContain('/tmp/bg-u1.pid');
        expect(bg.killScript).toContain('kill -TERM');
    });
});
