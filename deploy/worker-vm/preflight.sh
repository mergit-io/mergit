#!/usr/bin/env bash
# Checks the worker VM is ready, before `docker compose up`. One line per check; exits non-zero if any failed.
#   cd deploy/worker-vm && ./preflight.sh
# It reads worker.env as text and never runs it, and never prints a secret.
# API_URL / GATEWAY_URL / STORE_URL override the hosted addresses (for a staging stack).
set -uo pipefail
cd "$(dirname "$0")"
api=${API_URL:-https://api.mergit.site}
gateway=${GATEWAY_URL:-https://gateway.mergit.site}
store=${STORE_URL:-https://store.mergit.site}
workspaces=${WORKSPACES:-/var/lib/mergit/workspaces}
bad=0
ok()   { echo "ok:   $*"; }
fail() { echo "FAIL: $*" >&2; bad=1; }
get()  { grep -E "^$1=" worker.env 2>/dev/null | tail -1 | cut -d= -f2-; }

command -v docker >/dev/null || fail "docker is not installed"
docker info >/dev/null 2>&1 && ok "the Docker daemon answers" || fail "cannot reach the Docker daemon (is this user in the docker group?)"

if [ -f worker.env ]; then
  ok "worker.env exists"
  [ "$(stat -c %a worker.env 2>/dev/null)" = 600 ] && ok "worker.env is mode 600" || fail "worker.env holds secrets: chmod 600 worker.env"
  for v in WORKER_ID DATABASE_URL EVENTS_TOKEN STORE_WRITE_TOKEN WORKER_TOKEN; do
    [ -n "$(get $v)" ] && ok "$v is set" || fail "$v is empty or missing in worker.env"
  done
  case "$(get DATABASE_URL)" in *CHANGE-ME*) fail "DATABASE_URL still has the CHANGE-ME placeholder" ;; esac
  case "$(get DATABASE_URL)" in *@127.0.0.1*|*@localhost*) fail "DATABASE_URL points at this machine: use the server's private address" ;; esac
  [ -n "$(get ANTHROPIC_API_KEY)$(get GROQ_API_KEY)" ] && ok "a model key is set" || fail "set ANTHROPIC_API_KEY or GROQ_API_KEY"
else
  fail "worker.env is missing: copy worker.env.example and fill it in"
fi

for f in deployments/base-sepolia.json deployments/agents-base-sepolia.json; do
  if [ -f "$f" ]; then ok "$f is a file"; else
    fail "$f is not a file. Copy it from mergit-contracts/deployments. If a directory of that name exists, Docker made it: remove it"
  fi
done

if [ -f deployments/agents-base-sepolia.json ] && [ -f worker.env ]; then
  ids=$(python3 -c 'import json,sys; print(*[str(a["agent_id"]) for a in json.load(open(sys.argv[1]))["agents"]])' \
        deployments/agents-base-sepolia.json 2>/dev/null) || ids=""
  if [ -z "$ids" ]; then fail "cannot read the agent ids from deployments/agents-base-sepolia.json"; fi
  for id in $ids; do
    [[ "$(get "MERGIT_AGENT_KEY_$id")" =~ ^0x[0-9a-fA-F]{64}$ ]] \
      && ok "MERGIT_AGENT_KEY_$id is a 32-byte hex key" \
      || fail "MERGIT_AGENT_KEY_$id is missing or malformed (the worker refuses to start without it)"
  done
fi

docker image inspect mergit-sandbox:dev >/dev/null 2>&1 && ok "the sandbox image exists" \
  || fail "no sandbox image: docker build -t mergit-sandbox:dev ../../control-plane/sandbox"
[ -d "$workspaces" ] && [ -w "$workspaces" ] && ok "$workspaces exists and is writable" \
  || fail "$workspaces is missing or not writable: sudo install -d -o \$USER $workspaces"
free_gb=$(df --output=avail -BG "$workspaces" 2>/dev/null | tail -1 | tr -dc 0-9)
[ "${free_gb:-0}" -ge 10 ] && ok "${free_gb} GB free for checkouts" || fail "under 10 GB free where $workspaces lives (${free_gb:-?} GB)"

for pair in "api:$api" "gateway:$gateway" "store:$store"; do
  name=${pair%%:*}; url=${pair#*:}
  curl -fsS -m 8 -o /dev/null "$url/healthz" 2>/dev/null && ok "$name answers at $url/healthz" || fail "$name did not answer at $url/healthz"
done

if docker image inspect mergit-worker:local >/dev/null 2>&1 && [ -f worker.env ]; then
  docker run --rm --env-file worker.env --entrypoint python mergit-worker:local -c \
    "import os, psycopg; psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=8).close()" >/dev/null 2>&1 \
    && ok "the database accepts this worker's credentials" \
    || fail "the database refused or did not answer (private address, firewall, password, CP_DB_BIND on the server?)"
else
  echo "skip: the database check needs the worker image (docker compose build), run this again after it"
fi

[ "$bad" = 0 ] && echo "ready." || { echo "not ready: fix the FAIL lines above." >&2; exit 1; }
