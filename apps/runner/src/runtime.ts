/** Container backend used by the service layer. docker.ts implements it; tests mock it. */
export interface ExecResult {
    output: string;
    exitCode: number;
}

export interface StreamHandle {
    write(data: string): void;
    resize(cols: number, rows: number): Promise<void>;
    /** Tear down the local stream (does not necessarily kill the remote process). */
    close(): void;
    /** Resolves with the exit code once the process ends. */
    done: Promise<number>;
}

export interface OpenStreamOptions {
    cmd: string[];
    tty: boolean;
    stdin: boolean;
    cols?: number;
    rows?: number;
}

export interface LogFollow {
    close(): void;
    /** Resolves when the log stream ends (container stopped / restarted / closed). */
    ended: Promise<void>;
}

export interface ContainerRuntime {
    runningIds(): Promise<Set<string>>;
    isRunning(id: string): Promise<boolean>;
    /** Create + start the container and wait until its port answers HTTP. Idempotent when running. */
    start(id: string, port: number): Promise<void>;
    /** Stop and remove the container. Idempotent. */
    stop(id: string): Promise<void>;
    exec(id: string, command: string, timeoutMs: number): Promise<ExecResult>;
    openStream(id: string, opts: OpenStreamOptions, onData: (chunk: string) => void): Promise<StreamHandle>;
    followLogs(id: string, tail: number, onData: (chunk: string) => void): Promise<LogFollow>;
    restart(id: string): Promise<void>;
    /** Copy the image's /template into destDir (already created). */
    copyTemplate(destDir: string): Promise<void>;
    /** Remove labelled containers whose id is not in `known`. */
    removeOrphans(known: Set<string>): Promise<string[]>;
}
