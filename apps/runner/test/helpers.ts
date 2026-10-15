import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signToken } from '../src/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import type { ContainerRuntime, ExecResult } from '../src/runtime.js';
import { createApp, createDeps } from '../src/server.js';
import { Registry } from '../src/state.js';

export const SECRET = 'x'.repeat(40);

export function tmpDir(prefix = 'runner-test-'): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function testConfig(projectsDir: string, extra: Record<string, string> = {}): Config {
    return loadConfig({ RUNNER_SECRET: SECRET, PROJECTS_DIR: projectsDir, ...extra });
}

/** In-memory ContainerRuntime: no Docker. */
export class MockRuntime implements ContainerRuntime {
    running = new Set<string>();
    started: string[] = [];
    stopped: string[] = [];
    execCalls: { id: string; command: string }[] = [];
    execResult: ExecResult = { output: '', exitCode: 0 };

    async runningIds() {
        return new Set(this.running);
    }
    async isRunning(id: string) {
        return this.running.has(id);
    }
    async start(id: string) {
        this.running.add(id);
        this.started.push(id);
    }
    async stop(id: string) {
        this.running.delete(id);
        this.stopped.push(id);
    }
    async exec(id: string, command: string) {
        this.execCalls.push({ id, command });
        return this.execResult;
    }
    async openStream(): Promise<never> {
        throw new Error('not supported in mock');
    }
    async followLogs(): Promise<never> {
        throw new Error('not supported in mock');
    }
    async restart() {}
    async copyTemplate(destDir: string) {
        fs.writeFileSync(path.join(destDir, 'package.json'), '{"name":"template"}');
        fs.mkdirSync(path.join(destDir, 'src'), { recursive: true });
    }
    async removeOrphans() {
        return [];
    }
}

export function setup(extra: Record<string, string> = {}) {
    const dir = tmpDir();
    const config = testConfig(dir, extra);
    const registry = new Registry(config.projectsDir, config.portMin, config.portMax);
    const runtime = new MockRuntime();
    const deps = createDeps(config, registry, runtime);
    const app = createApp(deps);
    const nowSec = () => Math.floor(Date.now() / 1000);
    const admin = signToken({ sid: '*', uid: 'u1', exp: nowSec() + 600 }, SECRET);
    const tokenFor = (sid: string) => signToken({ sid, uid: 'u1', exp: nowSec() + 600 }, SECRET);
    const call = (method: string, url: string, token: string | null, body?: unknown) =>
        app.request(url, {
            method,
            headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    return { dir, config, registry, runtime, deps, app, admin, tokenFor, call };
}
