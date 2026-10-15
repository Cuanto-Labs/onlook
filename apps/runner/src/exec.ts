import { randomUUID } from 'node:crypto';

/** POSIX single-quote a string. */
export const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;

export const clampTimeout = (ms: unknown): number => {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DEFAULT_EXEC_TIMEOUT_MS;
    return Math.min(Math.floor(ms), MAX_EXEC_TIMEOUT_MS);
};

/** `timeout`-wrapped `sh -lc` argv: exit code 124 on timeout, then KILL 5 s later. */
export const wrapShell = (command: string, timeoutMs: number): string[] => [
    'timeout',
    '-k',
    '5',
    `${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
    'sh',
    '-lc',
    command,
];

/** Parse `git status --porcelain -z` output into changed file paths. */
export function parsePorcelainZ(out: string): string[] {
    const recs = out.split('\0');
    const files: string[] = [];
    for (let i = 0; i < recs.length; i++) {
        const rec = recs[i]!;
        if (rec.length < 4) continue;
        const x = rec[0]!;
        files.push(rec.slice(3));
        if (x === 'R' || x === 'C' || rec[1] === 'R' || rec[1] === 'C') i++; // skip orig path record
    }
    return files;
}

export const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;
export const TRUNCATION_NOTE = '\n[output truncated at 1 MB]\n';

/** Accumulates exec output up to `max` bytes; later data is dropped and a note is appended to the result. */
export function createOutputCapture(max = MAX_EXEC_OUTPUT_BYTES) {
    let out = '';
    let bytes = 0;
    let truncated = false;
    return {
        push(s: string) {
            if (truncated) return;
            const len = Buffer.byteLength(s);
            if (bytes + len <= max) {
                out += s;
                bytes += len;
                return;
            }
            truncated = true;
            const part = Buffer.from(s).subarray(0, max - bytes).toString('utf8').replace(/\uFFFD+$/, '');
            out += part;
            bytes = max;
        },
        get truncated() {
            return truncated;
        },
        result() {
            return truncated ? out + TRUNCATION_NOTE : out;
        },
    };
}

export const GIT_STATUS_CMD = 'git status --porcelain -z';

export interface BgCommand {
    pidFile: string;
    /** argv to run in the container. */
    cmd: string[];
    /** shell script that kills the process tree rooted at the recorded pid. */
    killScript: string;
}

/**
 * Background command whose pid is recorded so it can be killed through a second exec.
 * `sh -lc 'echo $$ > pidfile; exec sh -c <command>'`: the pid file holds the pid of the process that execs the command.
 */
export function buildBgCommand(command: string, uuid: string = randomUUID()): BgCommand {
    const pidFile = `/tmp/bg-${uuid}.pid`;
    return {
        pidFile,
        cmd: ['sh', '-lc', `echo $$ > ${pidFile}; exec sh -c ${shQuote(command)}`],
        killScript:
            `p=$(cat ${pidFile} 2>/dev/null) || exit 0; ` +
            `tree(){ for c in $(cat /proc/$1/task/*/children 2>/dev/null); do tree $c; done; echo $1; }; ` +
            `pids=$(tree $p); kill -TERM $pids 2>/dev/null; sleep 2; kill -KILL $pids 2>/dev/null; rm -f ${pidFile}; exit 0`,
    };
}
