#!/usr/bin/env bash
# End-to-end check 2 (deploy/e2e/false_receipt.md), driven without the planner: a dishonest operator who holds the
# platform's upload and event tokens commits a receipt that says the check passed when it failed. Expect the chain to
# accept the commitment (the signature is genuine), the validator to record `invalid`, and the plan's money to come back.
#
#   deploy/e2e/false_receipt.sh <requester-address>          run it where the secret files below exist
#   DRY_RUN=1 deploy/e2e/false_receipt.sh <requester-address>   build and check the false receipt locally, send nothing
#
# <requester-address> is the plan's requester. Use a fresh address nobody holds a key for (`cast wallet new` and keep only
# the address): the plan is funded from free credits, which are per address.
#
# Reads, and never prints: EVENTS_TOKEN, STORE_WRITE_TOKEN and RPC_URL from deploy/secrets/testnet.env, and the agent's
# runtime key from ../mergit-contracts/.env.services (MERGIT_AGENT_KEY_<agent>). For a dry run only, AGENT_KEY in the
# environment replaces the file. Optional: AGENT_ID (default 1), GATEWAY_URL, STORE_URL, WAIT_S (default 420).
# Needs cargo, cast, curl and python3. The forged-receipt builder is a test fixture: no service or image enables it.
set -euo pipefail
set +x
cd "$(dirname "$0")/../.."
[ $# -eq 1 ] || { echo "usage: $0 <requester-address>" >&2; exit 2; }
requester=$1
[[ $requester =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "requester must be an address" >&2; exit 2; }
agent=${AGENT_ID:-1}
gateway=${GATEWAY_URL:-https://gateway.mergit.site}
store=${STORE_URL:-https://store.mergit.site}
wait_s=${WAIT_S:-420}
deployment=../mergit-contracts/deployments/base-sepolia.json
for tool in cargo cast curl python3; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }; done
[ -e "$deployment" ] || { echo "$deployment missing" >&2; exit 1; }
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$deployment" "$1"; }
escrow=$(field escrow); registry=$(field receipt_registry); chain_id=$(field chain_id)

# Secrets are read into variables of this process only; nothing below echoes them.
if [ -n "${DRY_RUN:-}" ]; then
  key=${AGENT_KEY:?DRY_RUN needs AGENT_KEY (any throwaway key) in the environment}
  events_token=dry-run; store_token=dry-run; rpc=
else
  [ -e deploy/secrets/testnet.env ] || { echo "deploy/secrets/testnet.env missing" >&2; exit 1; }
  [ -e ../mergit-contracts/.env.services ] || { echo "../mergit-contracts/.env.services missing" >&2; exit 1; }
  events_token=$(set -a; . deploy/secrets/testnet.env; echo "${EVENTS_TOKEN:-}")
  store_token=$(set -a; . deploy/secrets/testnet.env; echo "${STORE_WRITE_TOKEN:-}")
  rpc=$(set -a; . deploy/secrets/testnet.env; echo "${RPC_URL:-}")
  key=$(set -a; . ../mergit-contracts/.env.services; v="MERGIT_AGENT_KEY_$agent"; echo "${!v:-}")
  [ -n "$events_token" ] && [ -n "$store_token" ] && [ -n "$rpc" ] || { echo "a token or RPC_URL is empty in testnet.env" >&2; exit 1; }
  [ -n "$key" ] || { echo "MERGIT_AGENT_KEY_$agent is not in .env.services" >&2; exit 1; }
fi

uuid=$(cat /proc/sys/kernel/random/uuid)
plan_id=$(cast keccak "$uuid")
task_id=$(cast keccak "$(cast abi-encode --packed 'f(bytes32,uint32,uint32)' "$plan_id" 0 1)")
out=$(mktemp -d)
echo "plan_uuid=$uuid"; echo "plan_id=$plan_id"; echo "task_id=$task_id"; echo "files: $out"

echo "1/6 building the false receipt (this compiles on first use)"
cargo run -q -p mergit-receipt --features forgery-fixture --example false_receipt -- \
  --task "$task_id" --plan "$plan_id" --agent "$agent" --requester "$requester" \
  --key "$key" --chain-id "$chain_id" --registry "$registry" --out "$out"
echo "2/6 the verifier must call it invalid (PHI_RESULT_CONTRADICTED)"
verdict=$(cargo run -q -p mergit-verifier -- "$out/bundle.json" --chain-id "$chain_id" --registry "$registry" || true)
echo "$verdict" | head -5
echo "$verdict" | grep -q "PHI_RESULT_CONTRADICTED" || { echo "FAIL: the verifier did not flag the forgery" >&2; exit 1; }
if [ -n "${DRY_RUN:-}" ]; then echo "dry run: stopping before anything is sent"; exit 0; fi

phi_hash=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["receipt"]["header"]["phi_hash"])' "$out/bundle.json")
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
post_event() { # type payload-json -> HTTP status
  local body; body=$(python3 -c 'import json,sys,uuid; print(json.dumps({"event_id": str(uuid.uuid4()), "type": sys.argv[1], "at": sys.argv[2], "payload": json.loads(sys.argv[3])}))' "$1" "$(now)" "$2")
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$gateway/v0/events" -H "Authorization: Bearer $events_token" \
    -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" -H 'content-type: application/json' --data "$body"
}

echo "3/6 funding the plan from free credits"
code=$(post_event plan.approved "{\"plan_id\":\"$plan_id\",\"plan_uuid\":\"$uuid\",\"requester\":\"$requester\",\"total_budget_usdc_units\":\"1000000\",\"funding\":\"credits\"}")
echo "    plan.approved -> HTTP $code"; [ "$code" = 200 ] || { echo "FAIL: the gateway refused the plan" >&2; exit 1; }

echo "4/6 locking one task for agent $agent (the receipt's own check, so the Φ hash matches)"
deadline=$(( $(date +%s) + 1800 ))
for attempt in $(seq 1 12); do
  code=$(post_event task.dispatch_requested "{\"task_id\":\"$task_id\",\"plan_id\":\"$plan_id\",\"index\":0,\"attempt\":1,\"agent_id\":\"$agent\",\"amount_usdc_units\":\"1000000\",\"category\":\"test-repair\",\"phi_hash\":\"$phi_hash\",\"deadline_unix\":$deadline}")
  echo "    task.dispatch_requested -> HTTP $code"
  [ "$code" = 200 ] && break
  sleep 10
done
[ "$code" = 200 ] || { echo "FAIL: the task was never locked" >&2; exit 1; }

echo "5/6 uploading the bundle, then announcing the receipt, as a worker would"
curl -sS -o /dev/null -w '    PUT /v0/bundles -> HTTP %{http_code}\n' -X PUT "$store/v0/bundles" -H "Authorization: Bearer $store_token" \
  -H 'content-type: application/json' --data @"$out/bundle.json"
curl -sS -o /dev/null -w '    receipt.sealed -> HTTP %{http_code}\n' -X POST "$gateway/v0/events" -H "Authorization: Bearer $events_token" \
  -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" -H 'content-type: application/json' --data @"$out/receipt-sealed.json"

echo "6/6 waiting up to ${wait_s}s for the escrow to settle task $task_id"
states=(None Locked Released Returned); verdicts=(None Pass Fail Invalid)
end=$(( $(date +%s) + wait_s ))
while [ "$(date +%s)" -lt "$end" ]; do
  read -r -d '' -a t < <(cast call "$escrow" 'taskOf(bytes32)(bytes32,uint256,address,uint256,uint64,uint8,uint8,uint64)' "$task_id" --rpc-url "$rpc" | awk '{print $1}'; printf '\0') || true
  state=${t[5]:-0}; verdict=${t[6]:-0}
  echo "    escrow state=${states[$state]:-?} verdict=${verdicts[$verdict]:-?}"
  if [ "$state" = 3 ]; then
    if [ "$verdict" = 3 ]; then
      echo "PASS: the false receipt was committed, judged Invalid, and the task was Returned."
      echo "Record the transactions from BaseScan: https://sepolia.basescan.org/address/$escrow#events (filter by task $task_id)"
      exit 0
    fi
    echo "FAIL: the task was returned with verdict ${verdicts[$verdict]:-?}, not Invalid" >&2; exit 1
  fi
  [ "$state" = 2 ] && { echo "FAIL: the task was RELEASED to the agent: the false receipt was paid" >&2; exit 1; }
  sleep 15
done
echo "FAIL: not settled in ${wait_s}s (is the validator running?)" >&2; exit 1
