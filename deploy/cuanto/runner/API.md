# Onlook runner API (Cuanto self-hosted preview runner)

Contract between `apps/runner` (server, on deb) and `packages/code-provider/src/providers/docker` (client, browser + onlook-web server). Change both sides together.

## Topology
- Runner listens on `127.0.0.1:3102` (host network). Browser reaches it at `NEXT_PUBLIC_RUNNER_URL` (`https://deb.tail789fa0.ts.net:4812`, tailscale serve); onlook-web server at `RUNNER_INTERNAL_URL` (`http://127.0.0.1:3102`).
- One Docker container per sandbox: name `onlook-sbx-<id>`, image `onlook-sandbox:1`, `/app` = bind mount of `${PROJECTS_DIR}/<id>` (default `/opt/onlook/projects`), container port 3000 published to `127.0.0.1:<port>`.
- Preview URL for a sandbox: `https://${NEXT_PUBLIC_SANDBOX_PREVIEW_HOST}:<port>` (host `deb.tail789fa0.ts.net`).

## Sandbox ids
`dk<port>-<6 chars [a-z0-9]>`, e.g. `dk4901-a8k2pq`. Regex: `^dk(\d{4,5})-[a-z0-9]{6}$`. Port range 4900-4919 (`PORT_MIN`/`PORT_MAX` env). The runner allocates the port at create time; ids are never reused while the sandbox exists.

## Auth
- Token = `base64url(JSON payload) + "." + base64url(HMAC-SHA256(RUNNER_SECRET, payloadPart))`.
- Payload: `{ "sid": "<sandbox id>" | "*", "uid": "<user id>", "exp": <unix seconds> }`.
- `sid: "*"` = admin token (onlook-web server only): required for `POST /sandboxes`, `GET /sandboxes`, `DELETE /sandboxes/:id`; also valid for every per-sandbox route.
- Per-sandbox token (sid = id) is valid only for routes under `/sandboxes/<that id>/`. Browser gets one from `sandbox.start` (12 h).
- REST: `Authorization: Bearer <token>`. WebSocket: `?token=<token>` query param.
- Missing/invalid/expired → 401 `{ "error": "unauthorized" }`; wrong sandbox → 403. Constant-time compare.

## Paths
All `path` values are relative to the project root (`/app` in the container). Leading `/`, `./`, and a leading `/project/workspace/` are stripped. Anything resolving outside the root (`..`, absolute escape, symlink escape via realpath) → 400 `{ "error": "invalid path" }`.

## Errors
JSON `{ "error": string }` with 400 (bad input), 401, 403, 404 (no such sandbox/file), 409 (exists, overwrite=false), 503 (capacity: no free port), 500.

## REST routes (JSON bodies, `Content-Type: application/json`)
| Method + route | Body / query | Response |
|---|---|---|
| `GET /health` | – | text `ok` (no auth) |
| `POST /sandboxes` (admin) | `{ "fromId"?: string, "title"?: string }` | `{ "id": string, "port": number }`. No `fromId` → copy of image `/template`; with `fromId` → copy of that sandbox dir (`cp -a --reflink=auto`, excluding `.next`). Does not start it. |
| `GET /sandboxes` (admin) | – | `{ "sandboxes": [{ "id", "port", "running": boolean, "lastActive": ISO string }] }` |
| `DELETE /sandboxes/:id` (admin) | – | `{}`; removes container + dir, frees port |
| `POST /sandboxes/:id/start` | – | `{ "id", "port", "running": true }`; creates/starts container, waits ≤90 s until `127.0.0.1:<port>` answers HTTP (any status), enforces max running (LRU stop) |
| `POST /sandboxes/:id/stop` | – | `{}` |
| `POST /sandboxes/:id/ping` | – | `{}`; bumps lastActive (idle reaper stops after `IDLE_MINUTES`, default 30) |
| `GET /sandboxes/:id/fs/stat?path=` | – | `{ "type": "file"\|"directory", "isSymlink", "size", "mtime", "ctime", "atime" }` (ms epoch) |
| `GET /sandboxes/:id/fs/list?path=` | – | `{ "files": [{ "name", "type": "file"\|"directory", "isSymlink" }] }` |
| `GET /sandboxes/:id/fs/read?path=` | – | `{ "type": "text", "content": string }` or `{ "type": "binary", "content": base64 }` (binary = contains a NUL byte in first 8 KB or known binary extension) |
| `PUT /sandboxes/:id/fs/write` | `{ "path", "content", "encoding": "utf8"\|"base64", "overwrite"?: boolean (default true) }` | `{ "success": true }`; creates parent dirs |
| `POST /sandboxes/:id/fs/rename` | `{ "oldPath", "newPath" }` | `{}` |
| `POST /sandboxes/:id/fs/copy` | `{ "sourcePath", "targetPath", "recursive"?, "overwrite"? }` | `{}` |
| `POST /sandboxes/:id/fs/mkdir` | `{ "path" }` | `{}` (recursive, idempotent) |
| `DELETE /sandboxes/:id/fs?path=&recursive=true\|false` | – | `{}` |
| `GET /sandboxes/:id/fs/download?path=` | – | `application/gzip` tar of path (excludes `node_modules`, `.next`) |
| `POST /sandboxes/:id/exec` | `{ "command": string, "timeoutMs"?: number (default 120000, max 600000) }` | `{ "output": string, "exitCode": number }` (stdout+stderr merged; `sh -lc` in container, cwd `/app`; container must be running → else 409) |
| `GET /sandboxes/:id/git-status` | – | `{ "changedFiles": string[] }` (from `git status --porcelain`) |

## WebSocket routes (JSON text frames)
| Route | Client → server | Server → client |
|---|---|---|
| `/sandboxes/:id/watch?path=&recursive=true&excludes=a,b` | – | `{ "type": "add"\|"change"\|"remove", "paths": string[] }` (relative paths, batched ≤100 ms; always ignores `node_modules`, `.next`, `.git`) |
| `/sandboxes/:id/pty?cols=&rows=` | `{ "type": "input", "data" }`, `{ "type": "resize", "cols", "rows" }` | `{ "type": "output", "data" }`, `{ "type": "exit", "code" }` (bash, cwd `/app`, TTY) |
| `/sandboxes/:id/task/dev` | `{ "type": "restart" }` | `{ "type": "output", "data" }` (last 200 log lines of the container's dev server, then follow; restart = container restart) |
| `/sandboxes/:id/bg?command=<urlencoded>` | `{ "type": "kill" }` | `{ "type": "output", "data" }`, `{ "type": "exit", "code" }` |

Every authenticated request/WS message on a sandbox counts as activity for the idle reaper.
