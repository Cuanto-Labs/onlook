import { describe, expect, test } from 'bun:test';
import { bearerToken, canAccess, isAdmin, signToken, verifyToken } from '../src/auth.js';
import { SECRET } from './helpers.js';

const now = 1_800_000_000;
const sid = 'dk4901-a8k2pq';

describe('auth tokens', () => {
    test('sign + verify round trip', () => {
        const t = signToken({ sid, uid: 'u1', exp: now + 60 }, SECRET);
        expect(t.split('.')).toHaveLength(2);
        expect(verifyToken(t, SECRET, now)).toEqual({ sid, uid: 'u1', exp: now + 60 });
    });

    test('expired', () => {
        const t = signToken({ sid, uid: 'u1', exp: now - 1 }, SECRET);
        expect(verifyToken(t, SECRET, now)).toBeNull();
        expect(verifyToken(signToken({ sid, uid: 'u1', exp: now }, SECRET), SECRET, now)).toBeNull();
    });

    test('tampered payload or signature', () => {
        const t = signToken({ sid, uid: 'u1', exp: now + 60 }, SECRET);
        const [p, s] = t.split('.') as [string, string];
        const evil = Buffer.from(JSON.stringify({ sid: '*', uid: 'u1', exp: now + 60 })).toString('base64url');
        expect(verifyToken(`${evil}.${s}`, SECRET, now)).toBeNull();
        expect(verifyToken(`${p}.${s.slice(0, -2)}AA`, SECRET, now)).toBeNull();
        expect(verifyToken(`${p}.`, SECRET, now)).toBeNull();
        expect(verifyToken('garbage', SECRET, now)).toBeNull();
        expect(verifyToken(`${p}.${s}.x`, SECRET, now)).toBeNull();
    });

    test('wrong secret', () => {
        const t = signToken({ sid, uid: 'u1', exp: now + 60 }, SECRET);
        expect(verifyToken(t, 'y'.repeat(40), now)).toBeNull();
    });

    test('rejects malformed payloads', () => {
        const part = Buffer.from(JSON.stringify({ sid, exp: now + 60 })).toString('base64url');
        const { createHmac } = require('node:crypto') as typeof import('node:crypto');
        const sig = createHmac('sha256', SECRET).update(part).digest('base64url');
        expect(verifyToken(`${part}.${sig}`, SECRET, now)).toBeNull(); // no uid
    });

    test('wrong-sandbox vs admin access', () => {
        const own = { sid, uid: 'u', exp: now };
        const admin = { sid: '*', uid: 'u', exp: now };
        expect(canAccess(own, sid)).toBe(true);
        expect(canAccess(own, 'dk4902-zzzzzz')).toBe(false);
        expect(canAccess(admin, 'dk4902-zzzzzz')).toBe(true);
        expect(isAdmin(admin)).toBe(true);
        expect(isAdmin(own)).toBe(false);
    });

    test('bearer header parsing', () => {
        expect(bearerToken('Bearer abc.def')).toBe('abc.def');
        expect(bearerToken('bearer abc')).toBe('abc');
        expect(bearerToken('Basic abc')).toBeNull();
        expect(bearerToken(undefined)).toBeNull();
    });
});
