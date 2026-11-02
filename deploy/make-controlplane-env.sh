#!/usr/bin/env bash
# Writes deploy/secrets/api.env and deploy/secrets/worker.env (mode 600, git-ignored) for compose.controlplane.yaml.
#   deploy/make-controlplane-env.sh [app-domain]        default mergit.site. On a laptop pass the page's host WITH its port,
#                                                       e.g. localhost:5173: sign-in checks it against window.location.host.
# The service tokens are copied from deploy/secrets/testnet.env (run make-testnet-env.sh first) so the gateway and the
# control plane agree. MERGIT_AGENT_KEY_1 comes from ../../mergit-contracts/.env.services. Each agent and the planner
# name their own provider in control-plane/agents.toml's [agents.<name>]/[providers.<name>] tables now (the
# deployed agent, mergit-coder-0, is hardcoded to Anthropic there); this script just collects whichever keys those
# configured providers need. The model keys are read from $ANTHROPIC_API_KEY / $GROQ_API_KEY / $OPENROUTER_API_KEY
# or asked for without echo; give whichever ones the configured providers need (Enter skips one). Prints names only,
# never values. An Anthropic credential is required: the planner and mergit-coder-0 are both provider =
# "anthropic" today; Groq/OpenRouter keys may still be given as extras for providers not yet deployed here.
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
# The planner and mergit-coder-0 are both provider = "anthropic" in agents.toml today, so this deployment
# specifically needs an Anthropic credential; GROQ_API_KEY/OPENROUTER_API_KEY alone would pass a looser
# check but produce env files that fail to start these actual services. Groq/OpenRouter keys are still
# accepted above and written out as extras, for providers not yet deployed here.
[ -n "${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}" ] || { echo "an Anthropic credential is required (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN): the planner and mergit-coder-0 are both provider = \"anthropic\"" >&2; exit 1; }
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
  echo "PLANNER_MODEL=claude-haiku-4-5"
  # PLANNER_PROVIDER is hardcoded the same way PLANNER_MODEL above is: a deployment choice, not derived
  # from which keys were given. The actual deployed agent, mergit-coder-0, is hardcoded to Anthropic the
  # same way in agents.toml.
  echo "PLANNER_PROVIDER=anthropic"
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
