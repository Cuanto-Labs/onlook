import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { loadConfig } from './config.js';
import { DockerRuntime } from './docker.js';
import { startReaper } from './reaper.js';
import { createApp, createDeps } from './server.js';
import { Registry } from './state.js';
import { attachWebSocket } from './ws.js';

const config = loadConfig();
const registry = new Registry(config.projectsDir, config.portMin, config.portMax);
const runtime = new DockerRuntime(config);
const deps = createDeps(config, registry, runtime);

const server = serve(
    { fetch: createApp(deps).fetch, hostname: config.host, port: config.port },
    (info) => console.log(`[runner] listening on ${info.address}:${info.port}`),
) as Server;
attachWebSocket(server, deps);
const stopReaper = startReaper(deps.service);

runtime
    .removeOrphans(new Set(registry.list().map((r) => r.id)))
    .then((ids) => ids.length && console.log(`[runner] removed orphan containers: ${ids.join(', ')}`))
    .catch((e) => console.error('[runner] orphan sweep failed:', e instanceof Error ? e.message : e));

const shutdown = () => {
    stopReaper();
    registry.flushIfDirty();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
