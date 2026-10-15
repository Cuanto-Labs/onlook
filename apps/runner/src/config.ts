export interface Config {
    secret: string;
    host: string;
    port: number;
    projectsDir: string;
    sandboxImage: string;
    portMin: number;
    portMax: number;
    maxRunning: number;
    idleMinutes: number;
    sandboxMemMb: number;
    sandboxCpus: number;
    /** First per-sandbox uid/gid; sandbox uid = uidBase + (port - portMin). */
    uidBase: number;
    /** Dedicated docker bridge network for sandbox containers (icc disabled). */
    sandboxNetwork: string;
}

function int(env: NodeJS.ProcessEnv, key: string, dflt: number, min = 1): number {
    const raw = env[key];
    if (raw === undefined || raw === '') return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`${key} must be an integer >= ${min}`);
    return n;
}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
    const raw = env[key];
    if (raw === undefined || raw === '') return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number`);
    return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const secret = env.RUNNER_SECRET ?? '';
    if (secret.length < 32) throw new Error('RUNNER_SECRET is required and must be >= 32 chars');
    const cfg: Config = {
        secret,
        host: env.RUNNER_HOST || '127.0.0.1',
        port: int(env, 'RUNNER_PORT', 3102),
        projectsDir: (env.PROJECTS_DIR || '/opt/onlook/projects').replace(/\/+$/, '') || '/',
        sandboxImage: env.SANDBOX_IMAGE || 'onlook-sandbox:1',
        portMin: int(env, 'PORT_MIN', 4900),
        portMax: int(env, 'PORT_MAX', 4919),
        maxRunning: int(env, 'MAX_RUNNING', 4),
        idleMinutes: int(env, 'IDLE_MINUTES', 30),
        sandboxMemMb: int(env, 'SANDBOX_MEM_MB', 1536),
        sandboxCpus: num(env, 'SANDBOX_CPUS', 2),
        uidBase: int(env, 'SANDBOX_UID_BASE', 61000, 1000),
        sandboxNetwork: env.SANDBOX_NETWORK || 'onlook-sbx',
    };
    if (cfg.portMax < cfg.portMin) throw new Error('PORT_MAX must be >= PORT_MIN');
    if (cfg.uidBase + (cfg.portMax - cfg.portMin) > 4_000_000_000) throw new Error('SANDBOX_UID_BASE too large');
    return cfg;
}

export interface SandboxIdentity {
    uid: number;
    gid: number;
}

/** Per-sandbox uid/gid: uidBase + (port - portMin). Every sandbox gets a distinct unprivileged identity. */
export function sandboxIdentity(cfg: Pick<Config, 'uidBase' | 'portMin' | 'portMax'>, port: number): SandboxIdentity {
    if (!Number.isInteger(port) || port < cfg.portMin || port > cfg.portMax) {
        throw new Error(`port ${port} outside PORT_MIN..PORT_MAX`);
    }
    const id = cfg.uidBase + (port - cfg.portMin);
    return { uid: id, gid: id };
}
