#!/usr/bin/env bash
# Writes deploy/secrets/api.env and deploy/secrets/worker.env (mode 600, git-ignored) for compose.controlplane.yaml.
#   deploy/make-controlplane-env.sh [app-domain]        default mergit.site. On a laptop pass the page's host WITH its port,
#                                                       e.g. localhost:5173: sign-in checks it against window.location.host.
# The service tokens are copied from deploy/secrets/testnet.env (run make-testnet-env.sh first) so the gateway and the
# control plane agree. MERGIT_AGENT_KEY_1 comes from ../../mergit-contracts/.env.services. Each agent and the planner
# name their own provider: the agents in control-plane/agents.toml (the deployed one, mergit-coder-0, is
# provider = "openrouter"), the planner in PLANNER_PROVIDER, which this script writes. Choose it with
# PLANNER_PROVIDER=openrouter|anthropic|groq in the environment (default openrouter); PLANNER_MODEL defaults to that
# provider's id for Claude Haiku 4.5 (Groq: openai/gpt-oss-120b). The model keys are read from $OPENROUTER_API_KEY /
# $ANTHROPIC_API_KEY / $GROQ_API_KEY or asked for without echo (Enter skips one); every key given is written, so a
# deployment can switch provider later without regenerating. The planner's provider must have its key. Prints names
# only, never values.
set -euo pipefail
cd "$(dirname "$0")"
domain=${1:-mergit.site}
svc=../../mergit-contracts/.env.services
[ -e secrets/testnet.env ] || { echo "secrets/testnet.env missing: run make-testnet-env.sh first" >&2; exit 1; }
[ -e "$svc" ] || { echo "$svc missing" >&2; exit 1; }
{ [ ! -e secrets/api.env ] && [ ! -e secrets/worker.env ]; } || { echo "secrets/api.env or worker.env exists; delete them to regenerate" >&2; exit 1; }

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
if [ -z "${OPENROUTER_API_KEY:-}" ]; then read -rsp "OPENROUTER_API_KEY (input hidden, Enter to skip): " OPENROUTER_API_KEY; echo; fi
planner_provider=${PLANNER_PROVIDER:-openrouter}
case "$planner_provider" in
  openrouter) planner_model=${PLANNER_MODEL:-anthropic/claude-haiku-4.5}; planner_key=${OPENROUTER_API_KEY:-} ;;
  anthropic) planner_model=${PLANNER_MODEL:-claude-haiku-4-5}; planner_key=${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-} ;;
  groq) planner_model=${PLANNER_MODEL:-openai/gpt-oss-120b}; planner_key=${GROQ_API_KEY:-} ;;
  *) echo "PLANNER_PROVIDER must be openrouter, anthropic or groq, not $planner_provider" >&2; exit 1 ;;
esac
[ -n "$planner_key" ] || { echo "the planner's provider ($planner_provider) needs its key; none was given" >&2; exit 1; }
# The deployed agent's provider is in agents.toml, not here; the worker's start-up check (and update.sh's preflight)
# refuses a missing key exactly. This only warns early for the shipped default.
[ -n "${OPENROUTER_API_KEY:-}" ] || echo "note: no OPENROUTER_API_KEY, but mergit-coder-0 is provider = \"openrouter\" in agents.toml: the worker will not start unless agents.toml points it elsewhere" >&2
model_keys() { # only the keys that were given, so each configured provider gets the key it needs
  [ -z "${ANTHROPIC_API_KEY:-}" ] || echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
  [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ] || echo "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN"
  [ -z "${ANTHROPIC_BASE_URL:-}" ] || echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
  [ -z "${GROQ_API_KEY:-}" ] || echo "GROQ_API_KEY=$GROQ_API_KEY"
  [ -z "${OPENROUTER_API_KEY:-}" ] || echo "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"
}
session=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
[ ${#session} -eq 64 ] || { echo "could not generate SESSION_SECRET" >&2; exit 1; }
scheme=https; case "$domain" in localhost*|127.0.0.1*) scheme=http ;; esac

umask 077
{
  echo "APP_DOMAIN=$domain"
  echo "CORS_ORIGINS=$scheme://$domain"
  echo "SESSION_SECRET=$session"
  echo "PLANNER_PROVIDER=$planner_provider"
  echo "PLANNER_MODEL=$planner_model"
  model_keys
  for t in EVENTS_TOKEN CHAIN_EVENTS_TOKEN WORKER_TOKEN; do echo "$t=$(token $t)"; done
} > secrets/api.env
{
  model_keys
  echo "MERGIT_AGENT_KEY_1=$agent_key"
  echo "APP_BASE_URL=$scheme://$domain"
  for t in EVENTS_TOKEN STORE_WRITE_TOKEN WORKER_TOKEN; do echo "$t=$(token $t)"; done
  # GITHUB_TOKEN=...   (optional: only the pull-request gate needs it; add it here by hand)
} > secrets/worker.env
echo "wrote deploy/secrets/api.env (APP_DOMAIN CORS_ORIGINS SESSION_SECRET PLANNER_MODEL PLANNER_PROVIDER, the model key(s) you gave, EVENTS_TOKEN CHAIN_EVENTS_TOKEN WORKER_TOKEN)"
echo "wrote deploy/secrets/worker.env (the model key(s) you gave, MERGIT_AGENT_KEY_1 APP_BASE_URL EVENTS_TOKEN STORE_WRITE_TOKEN WORKER_TOKEN)"
