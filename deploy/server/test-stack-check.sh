#!/usr/bin/env bash
# Asserts the guard in stack-check.sh fires, and stays quiet on a healthy stack. Run: deploy/server/test-stack-check.sh
set -uo pipefail
cd "$(dirname "$0")"
. ./stack-check.sh

fail=0
expect() {  # description, expected (space-separated service names), ps lines
  local got
  got=$(printf '%s\n' "$3" | unhealthy_services | tr '\n' ' ' | sed 's/ $//')
  if [ "$got" = "$2" ]; then echo "ok    $1"; else echo "FAIL  $1: expected '$2', got '$got'" >&2; fail=1; fi
}

healthy=$'api|running|healthy|0\ncaddy|running||0\ncp_postgres|running|healthy|0\ngateway|running||0\npostgres|running|healthy|0\nstore|running||0\nvalidator|running||0\nworker|running||0'

expect "a healthy stack is silent (services without a healthcheck have an empty health)" "" "$healthy"
expect "a restarting service is flagged (the gateway after #38)" "gateway" "${healthy/gateway|running||0/gateway|restarting||1}"
expect "an unhealthy service is flagged" "api" "${healthy/api|running|healthy|0/api|running|unhealthy|0}"
expect "an exited service is flagged even with exit code 0 (caddy after SIGTERM, 2026-11-05)" "caddy" "${healthy/caddy|running||0/caddy|exited||0}"
expect "a dead service is flagged" "store" "${healthy/store|running||0/store|dead||0}"
expect "a service that never started is flagged" "worker" "${healthy/worker|running||0/worker|created||0}"
two_bad=${healthy/gateway|running||0/gateway|restarting||1}
two_bad=${two_bad/worker|running||0/worker|exited||137}
expect "every bad service is named, in order" "gateway worker" "$two_bad"
expect "the whole stack stopped (dockerd restart with live-restore off)" "api caddy" $'api|exited||137\ncaddy|exited||0'

exit $fail
