#!/usr/bin/env bash
# One guided run of the mainnet one-shot (ens/RUNBOOK.md section 2). It shows the plan first and sends nothing until you
# type YES. The owner key is read from a hidden prompt, held only in this process, and never printed or written.
#   bash run-oneshot.sh --plan-only     show the plan (reads mainnet, needs no key)
#   bash run-oneshot.sh                 show the plan, then ask, then send
set -euo pipefail
cd "$(dirname "$0")"

export ENS_MAINNET_RPC="${ENS_MAINNET_RPC:-https://ethereum-rpc.publicnode.com}"
config="${ONESHOT_CONFIG:-agents.json}"

echo "== Plan (nothing is sent) =="
node src/oneshot-cli.ts "$config" --mainnet
[ "${1:-}" = "--plan-only" ] && exit 0

echo
read -r -p "Type YES to send these transactions from the mainnet owner wallet: " answer
[ "$answer" = "YES" ] || { echo "Not sent."; exit 1; }

trap 'unset ENS_OWNER_PRIVATE_KEY' EXIT
read -r -s -p "Owner key (hidden, not shown): " ENS_OWNER_PRIVATE_KEY
echo
export ENS_OWNER_PRIVATE_KEY
# Accept the key with or without the 0x prefix.
case "$ENS_OWNER_PRIVATE_KEY" in 0x*) ;; *) ENS_OWNER_PRIVATE_KEY="0x$ENS_OWNER_PRIVATE_KEY"; export ENS_OWNER_PRIVATE_KEY ;; esac

echo "== Sending =="
node src/oneshot-cli.ts "$config" --mainnet --execute
echo
echo "Done. Every row above should read ok. Check:"
echo "  https://app.ens.domains/mergit-coder-1.mergit.eth"
echo "  https://app.mergit.site/app/agents   (reload; coder-1 and coder-2 should show Verified on ENS)"
