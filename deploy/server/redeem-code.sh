#!/usr/bin/env bash
# Redeem codes: one-time codes that give an account extra credit (everyone gets 5 USDC free; a code adds more).
#   deploy/server/redeem-code.sh create --usdc 20 [--count N] [--note "who it is for"] [--expires-days D]
#   deploy/server/redeem-code.sh list                 id, amount, note and status of every code (never the code)
#   deploy/server/redeem-code.sh revoke <code_id>     make an unused code unusable
# `create` prints each code once and cannot show it again (only a keyed hash is stored). Give each code to one person.
# A code adds to the free 5 USDC, so a 20 USDC code leaves its owner with 25; use --usdc 15 for 20 in total.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml -f deploy/compose.server.yaml \
  exec -T api python -m mergit_cp.redeem_admin "$@"
