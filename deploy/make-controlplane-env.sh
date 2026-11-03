#!/usr/bin/env bash
# Writes deploy/secrets/api.env, worker.env and cp_postgres.env (mode 600, git-ignored) for compose.controlplane.yaml.
#   deploy/make-controlplane-env.sh [app-domain]        default mergit.site. On a laptop pass the page's host WITH its port,
#                                                       e.g. localhost:5173: sign-in checks it against window.location.host.
# The service tokens are copied from deploy/secrets/testnet.env (run make-testnet-env.sh first) so the gateway and the
# control plane agree. MERGIT_AGENT_KEY_1 comes from ../../mergit-contracts/.env.services. The model keys are read from
# $ANTHROPIC_API_KEY / $GROQ_API_KEY or asked for without echo; give either or both (Enter skips one). Anthropic is used
# when its key is present, Groq when only Groq's is (control-plane/mergit_worker/providers.py). Optional: GROQ_MODEL
# (default openai/gpt-oss-120b) and LLM_PROVIDER=anthropic|groq to force one. Prints names only, never values.
# The cp_postgres superuser password is generated here: cp_postgres.env sets it when the database is first created,
# and the API and the worker get it in DATABASE_URL. Postgres reads POSTGRES_PASSWORD only when its volume is empty,
# so for a database that already exists see deploy/server/README.md ("The database superuser password").
set -euo pipefail
cd "$(dirname "$0")"
domain=${1:-mergit.site}
svc=../../mergit-contracts/.env.services
[ -e secrets/testnet.env ] || { echo "secrets/testnet.env missing: run make-testnet-env.sh first" >&2; exit 1; }
[ -e "$svc" ] || { echo "$svc missing" >&2; exit 1; }
for f in api.env worker.env cp_postgres.env; do
  [ ! -e "secrets/$f" ] || {
    echo "secrets/$f exists; delete api.env, worker.env and cp_postgres.env to regenerate." >&2
    echo "WARNING: if this server's cp_pgdata volume already exists, regenerating writes a database password the" >&2
    echo "database never receives, and the API and the worker are locked out. Use the existing-database procedure in" >&2
    echo "deploy/server/README.md (\"The database superuser password\") instead." >&2
    exit 1
  }
done

token() { grep -E "^$1=.+" secrets/testnet.env | head -1 | cut -d= -f2-; }
for t in EVENTS_TOKEN CHAIN_EVENTS_TOKEN WORKER_TOKEN STORE_WRITE_TOKEN; do
  [ -n "$(token $t)" ] || { echo "$t is empty in secrets/testnet.env" >&2; exit 1; }
done
agent_key=$(set -a; . "$svc"; echo "${MERGIT_AGENT_KEY_1:-}")
[ -n "$agent_key" ] || { echo "MERGIT_AGENT_KEY_1 not found in $svc" >&2; exit 1; }
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then read -rsp "ANTHROPIC_API_KEY (input hidden, Enter to skip): " ANTHROPIC_API_KEY; echo; fi
if [ -z "${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}" ]; then read -rsp "ANTHROPIC_AUTH_TOKEN, for a gateway such as Claude Lend (input hidden, Enter to skip): " ANTHROPIC_AUTH_TOKEN; echo; fi
if [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_BASE_URL:-}" ]; then read -rp "ANTHROPIC_BASE_URL for that token: " ANTHROPIC_BASE_URL; fi
if [ -z "${GROQ_API_KEY:-}" ]; then read -rsp "GROQ_API_KEY (input hidden, Enter to skip): " GROQ_API_KEY; echo; fi
[ -n "${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}${GROQ_API_KEY:-}" ] || { echo "a model key is required (planner and agents): ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or GROQ_API_KEY" >&2; exit 1; }
model_keys() { # only the keys that were given, so the provider is chosen from what is actually there
  [ -z "${ANTHROPIC_API_KEY:-}" ] || echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
  [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ] || echo "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN"
  [ -z "${ANTHROPIC_BASE_URL:-}" ] || echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
  [ -z "${GROQ_API_KEY:-}" ] || echo "GROQ_API_KEY=$GROQ_API_KEY"
  [ -z "${GROQ_MODEL:-}" ] || echo "GROQ_MODEL=$GROQ_MODEL"
  [ -z "${LLM_PROVIDER:-}" ] || echo "LLM_PROVIDER=$LLM_PROVIDER"
}
session=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
[ ${#session} -eq 64 ] || { echo "could not generate SESSION_SECRET" >&2; exit 1; }
# Hex, so it needs no escaping in a URL.
pg_password=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
[ ${#pg_password} -eq 48 ] || { echo "could not generate the database password" >&2; exit 1; }
database_url="postgres://postgres:$pg_password@cp_postgres:5432/mergit_cp"
scheme=https; case "$domain" in localhost*|127.0.0.1*) scheme=http ;; esac

umask 077
echo "POSTGRES_PASSWORD=$pg_password" > secrets/cp_postgres.env
{
  echo "DATABASE_URL=$database_url"
  echo "APP_DOMAIN=$domain"
  echo "CORS_ORIGINS=$scheme://$domain"
  echo "SESSION_SECRET=$session"
  echo "PLANNER_MODEL=claude-haiku-4-5"  # on Groq the planner runs GROQ_MODEL instead (providers.py)
  model_keys
  for t in EVENTS_TOKEN CHAIN_EVENTS_TOKEN WORKER_TOKEN; do echo "$t=$(token $t)"; done
} > secrets/api.env
{
  echo "DATABASE_URL=$database_url"
  model_keys
  echo "MERGIT_AGENT_KEY_1=$agent_key"
  echo "APP_BASE_URL=$scheme://$domain"
  for t in EVENTS_TOKEN STORE_WRITE_TOKEN WORKER_TOKEN; do echo "$t=$(token $t)"; done
  # GITHUB_TOKEN=...   (optional: only the pull-request gate needs it; add it here by hand)
} > secrets/worker.env
echo "wrote deploy/secrets/cp_postgres.env (POSTGRES_PASSWORD)"
echo "wrote deploy/secrets/api.env (DATABASE_URL APP_DOMAIN CORS_ORIGINS SESSION_SECRET PLANNER_MODEL, the model key(s) you gave, EVENTS_TOKEN CHAIN_EVENTS_TOKEN WORKER_TOKEN)"
echo "wrote deploy/secrets/worker.env (DATABASE_URL, the model key(s) you gave, MERGIT_AGENT_KEY_1 APP_BASE_URL EVENTS_TOKEN STORE_WRITE_TOKEN WORKER_TOKEN)"
