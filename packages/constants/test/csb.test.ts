import { afterEach, describe, expect, test } from 'bun:test';

import { getSandboxPreviewUrl } from '../src/csb';

const saved = process.env.NEXT_PUBLIC_SANDBOX_PREVIEW_HOST;

afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SANDBOX_PREVIEW_HOST;
    else process.env.NEXT_PUBLIC_SANDBOX_PREVIEW_HOST = saved;
});

describe('getSandboxPreviewUrl', () => {
    test('CSB ids keep the csb.app pattern', () => {
        expect(getSandboxPreviewUrl('xzsy8c', 3000)).toBe('https://xzsy8c-3000.csb.app');
    });

    test('docker ids use the preview host and the port encoded in the id', () => {
        process.env.NEXT_PUBLIC_SANDBOX_PREVIEW_HOST = 'deb.example.ts.net';
        expect(getSandboxPreviewUrl('dk4901-a8k2pq', 3000)).toBe(
            'https://deb.example.ts.net:4901',
        );
        expect(getSandboxPreviewUrl('dk19999-abc123', 8080)).toBe(
            'https://deb.example.ts.net:19999',
        );
    });

    test('ids that only resemble docker ids stay on CSB', () => {
        expect(getSandboxPreviewUrl('dk4901-A8k2pq', 3000)).toBe(
            'https://dk4901-A8k2pq-3000.csb.app',
        );
    });
});
