import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { Readable } from 'node:stream';
import { bearerToken, canAccess, isAdmin, verifyToken } from './auth.js';
import type { Config } from './config.js';
import { HttpError } from './errors.js';
import { clampTimeout } from './exec.js';
import type { FsClientOptions } from './fsclient.js';
import { isValidId } from './ports.js';
import type { ContainerRuntime } from './runtime.js';
import { SandboxService } from './sandboxes.js';
import type { Registry } from './state.js';

export interface Deps {
    config: Config;
    registry: Registry;
    runtime: ContainerRuntime;
    service: SandboxService;
}

export function createDeps(
    config: Config,
    registry: Registry,
    runtime: ContainerRuntime,
    fsOpts?: FsClientOptions,
): Deps {
    return { config, registry, runtime, service: new SandboxService(config, registry, runtime, fsOpts) };
}

/** Request body caps: only fs/write may carry a big (base64 file) payload. */
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_WRITE_BODY_BYTES = 70 * 1024 * 1024;

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
    let b: unknown;
    try {
        b = await c.req.json();
    } catch (e) {
        // chunked body past the cap: let the bodyLimit middleware turn it into a 413
        if (e instanceof Error && e.name === 'BodyLimitError') throw e;
        throw new HttpError(400, 'invalid json');
    }
    if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new HttpError(400, 'invalid body');
    return b as Record<string, unknown>;
}

function reqString(o: Record<string, unknown>, key: string): string {
    const v = o[key];
    if (typeof v !== 'string') throw new HttpError(400, `${key} must be a string`);
    return v;
}

function optBool(o: Record<string, unknown>, key: string): boolean | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') throw new HttpError(400, `${key} must be a boolean`);
    return v;
}

const queryPath = (c: Context, required: boolean): string => {
    const p = c.req.query('path');
    if (p === undefined) {
        if (required) throw new HttpError(400, 'path is required');
        return '';
    }
    return p;
};

export function createApp(deps: Deps): Hono {
    const { config, service } = deps;
    const app = new Hono();

    // Auth is a bearer token (not cookies), so a permissive origin is safe.
    app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'], maxAge: 600 }));

    app.get('/health', (c) => c.text('ok'));

    // Authentication + authorisation + activity tracking for everything under /sandboxes.
    app.use('*', authMiddleware(config, deps.registry));

    const tooLarge = (c: Context) => c.json({ error: 'payload too large' }, 413);
    const smallBody = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge });
    const writeBody = bodyLimit({ maxSize: MAX_WRITE_BODY_BYTES, onError: tooLarge });
    app.use('*', (c, next) =>
        c.req.method === 'PUT' && /^\/sandboxes\/[^/]+\/fs\/write$/.test(c.req.path)
            ? writeBody(c, next)
            : smallBody(c, next),
    );

    const sandboxId = (c: Context) => c.req.param('id') as string;

    app.post('/sandboxes', async (c) => {
        const body = (await c.req.text()).trim() ? await jsonBody(c) : {};
        const fromId = body.fromId;
        const title = body.title;
        if (fromId !== undefined && (typeof fromId !== 'string' || !isValidId(fromId))) {
            throw new HttpError(400, 'invalid fromId');
        }
        if (title !== undefined && typeof title !== 'string') throw new HttpError(400, 'title must be a string');
        const rec = await service.create(fromId as string | undefined, title as string | undefined);
        return c.json({ id: rec.id, port: rec.port });
    });

    app.get('/sandboxes', async (c) => c.json({ sandboxes: await service.list() }));

    app.delete('/sandboxes/:id', async (c) => {
        await service.remove(sandboxId(c));
        return c.json({});
    });

    app.post('/sandboxes/:id/start', async (c) => {
        const id = sandboxId(c);
        await service.start(id);
        return c.json({ id, port: service.require(id).port, running: true });
    });

    app.post('/sandboxes/:id/stop', async (c) => {
        await service.stop(sandboxId(c));
        return c.json({});
    });

    app.post('/sandboxes/:id/ping', (c) => c.json({}));

    // ---- filesystem
    // Every project fs call runs in the sandbox's own unprivileged worker (see fsclient.ts), never as root here.
    const root = (c: Context) => service.fsFor(sandboxId(c));

    app.get('/sandboxes/:id/fs/stat', async (c) => c.json(await root(c).stat(queryPath(c, true))));
    app.get('/sandboxes/:id/fs/list', async (c) => c.json(await root(c).list(queryPath(c, false))));
    app.get('/sandboxes/:id/fs/read', async (c) => c.json(await root(c).read(queryPath(c, true))));

    app.put('/sandboxes/:id/fs/write', async (c) => {
        const b = await jsonBody(c);
        const encoding = b.encoding === undefined ? 'utf8' : b.encoding;
        if (encoding !== 'utf8' && encoding !== 'base64') throw new HttpError(400, 'invalid encoding');
        await root(c).write(reqString(b, 'path'), reqString(b, 'content'), encoding, optBool(b, 'overwrite') ?? true);
        return c.json({ success: true });
    });

    app.post('/sandboxes/:id/fs/rename', async (c) => {
        const b = await jsonBody(c);
        await root(c).rename(reqString(b, 'oldPath'), reqString(b, 'newPath'));
        return c.json({});
    });

    app.post('/sandboxes/:id/fs/copy', async (c) => {
        const b = await jsonBody(c);
        await root(c).copy(
            reqString(b, 'sourcePath'),
            reqString(b, 'targetPath'),
            optBool(b, 'recursive') ?? false,
            optBool(b, 'overwrite') ?? false,
        );
        return c.json({});
    });

    app.post('/sandboxes/:id/fs/mkdir', async (c) => {
        await root(c).mkdir(reqString(await jsonBody(c), 'path'));
        return c.json({});
    });

    app.delete('/sandboxes/:id/fs', async (c) => {
        await root(c).delete(queryPath(c, true), c.req.query('recursive') === 'true');
        return c.json({});
    });

    app.get('/sandboxes/:id/fs/download', async (c) => {
        const stream = await root(c).download(queryPath(c, false));
        return new Response(Readable.toWeb(stream) as ReadableStream, {
            headers: { 'content-type': 'application/gzip' },
        });
    });

    // ---- exec + git
    app.post('/sandboxes/:id/exec', async (c) => {
        const b = await jsonBody(c);
        const command = reqString(b, 'command');
        if (!command.trim()) throw new HttpError(400, 'command is empty');
        const id = sandboxId(c);
        await service.requireRunning(id);
        return c.json(await deps.runtime.exec(id, command, clampTimeout(b.timeoutMs)));
    });

    app.get('/sandboxes/:id/git-status', async (c) =>
        c.json({ changedFiles: await service.gitStatus(sandboxId(c)) }),
    );

    app.notFound((c) => c.json({ error: 'not found' }, 404));
    app.onError((err, c) => {
        if (err.name === 'BodyLimitError') return tooLarge(c);
        if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
        console.error('[runner] unhandled:', err instanceof Error ? err.stack : err);
        return c.json({ error: 'internal error' }, 500);
    });

    return app;
}

/**
 * 401 for missing/invalid/expired tokens, 403 for the wrong sandbox or a non-admin on admin routes,
 * 404 for an unknown id (admin or matching token only), then counts the call as activity.
 */
function authMiddleware(config: Config, registry: Registry) {
    return async (c: Context, next: () => Promise<void>) => {
        if (c.req.method === 'OPTIONS' || !/^\/sandboxes(\/|$)/.test(c.req.path)) return next();
        const token = bearerToken(c.req.header('authorization'));
        const payload = token ? verifyToken(token, config.secret) : null;
        if (!payload) return c.json({ error: 'unauthorized' }, 401);

        const m = /^\/sandboxes(?:\/([^/]+))?(\/.*)?$/.exec(c.req.path);
        const id = m?.[1];
        const rest = m?.[2];
        if (!id) {
            // /sandboxes (collection): admin only
            if (!isAdmin(payload)) return c.json({ error: 'forbidden' }, 403);
            return next();
        }
        if (!rest && c.req.method === 'DELETE') {
            if (!isAdmin(payload)) return c.json({ error: 'forbidden' }, 403);
        } else if (!canAccess(payload, id)) {
            return c.json({ error: 'forbidden' }, 403);
        }
        if (!isValidId(id) || !registry.get(id)) return c.json({ error: 'no such sandbox' }, 404);
        registry.touch(id);
        return next();
    };
}
