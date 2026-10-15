#!/usr/bin/env bash
# Expose the Onlook runner and the sandbox preview ports on the tailnet via `tailscale serve`.
#   4812            -> http://127.0.0.1:3102   (runner REST + WebSocket, NEXT_PUBLIC_RUNNER_URL)
#   PORT_MIN..MAX   -> http://127.0.0.1:<port> (one preview container per project, 4900-4919)
#
# Port collision check: preview containers publish on 127.0.0.1:<p> (Docker PortBindings HostIp=127.0.0.1) while
# `tailscale serve --https=<p>` terminates TLS on the node's tailnet addresses (100.x / fd7a:), never on 127.0.0.1
# or 0.0.0.0, so the same number can be used on both without a bind conflict. This script still refuses to
# overwrite a serve mapping that points somewhere else (set FORCE=1 to replace it).
#
# Idempotent: ports already mapped to the right target are skipped. Run on deb (tailscale serve needs root):
#   sudo bash deploy/cuanto/serve-ports.sh
set -euo pipefail

TS="${TAILSCALE_BIN:-tailscale}"
RUNNER_HTTPS_PORT="${RUNNER_HTTPS_PORT:-4812}"
RUNNER_LOCAL_PORT="${RUNNER_PORT:-3102}"
PORT_MIN="${PORT_MIN:-4900}"
PORT_MAX="${PORT_MAX:-4919}"
FORCE="${FORCE:-0}"

command -v "$TS" >/dev/null || { echo "tailscale not found (set TAILSCALE_BIN)" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 required to read 'tailscale serve status --json'" >&2; exit 1; }

status_json="$("$TS" serve status --json 2>/dev/null || true)"
[ -n "$status_json" ] || status_json='{}'

# Prints the proxy target currently mapped to path "/" of any https host on the given port, or nothing.
current_target() {
  STATUS_JSON="$status_json" python3 - "$1" <<'PY'
import json, os, sys
port = sys.argv[1]
try:
    d = json.loads(os.environ["STATUS_JSON"] or "{}")
except ValueError:
    sys.exit(0)
for host, cfg in (d.get("Web") or {}).items():
    if host.rsplit(":", 1)[-1] != port:
        continue
    h = (cfg.get("Handlers") or {}).get("/") or {}
    print(h.get("Proxy") or h.get("Path") or h.get("Text") or "other")
    break
PY
}

serve_port() {
  local https_port="$1" target="$2" cur
  cur="$(current_target "$https_port")"
  if [ "$cur" = "$target" ] || [ "$cur" = "$target/" ]; then
    echo "ok      :$https_port -> $target (already served)"
    return 0
  fi
  if [ -n "$cur" ] && [ "$FORCE" != "1" ]; then
    echo "ERROR   :$https_port already serves '$cur', not $target (FORCE=1 to replace)" >&2
    return 1
  fi
  if ! "$TS" serve --bg --https="$https_port" "$target" >/dev/null; then
    echo "FAILED  :$https_port -> $target (needs root or 'tailscale set --operator')" >&2
    return 1
  fi
  echo "served  :$https_port -> $target"
}

rc=0
serve_port "$RUNNER_HTTPS_PORT" "http://127.0.0.1:$RUNNER_LOCAL_PORT" || rc=1
for ((p = PORT_MIN; p <= PORT_MAX; p++)); do
  serve_port "$p" "http://127.0.0.1:$p" || rc=1
done
exit "$rc"
