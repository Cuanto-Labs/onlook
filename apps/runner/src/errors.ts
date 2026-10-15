export class HttpError extends Error {
    constructor(
        public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503,
        message: string,
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

/** Map a Node fs error to an HttpError; rethrow anything unrecognised. */
export function fsError(e: unknown): never {
    if (e instanceof HttpError) throw e;
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    switch (code) {
        case 'ENOENT':
            throw new HttpError(404, 'not found');
        case 'EEXIST':
        case 'ENOTEMPTY':
            throw new HttpError(409, 'already exists');
        case 'EISDIR':
        case 'ENOTDIR':
        case 'EINVAL':
        case 'ERR_FS_CP_EINVAL':
        case 'ERR_FS_EISDIR':
            throw new HttpError(400, 'invalid path');
        case 'EACCES':
        case 'EPERM':
            throw new HttpError(403, 'permission denied');
        default:
            throw e;
    }
}
