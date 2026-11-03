# End-to-end check 2: a false receipt is refused and the requester refunded

This plays a dishonest operator who also holds the platform's upload and event tokens (as a compromised worker
would): the check failed, but the receipt claims it passed, signed with the agent's real
runtime key. Only the evidence check catches it.

**Scripted (needs no model key):** `deploy/e2e/false_receipt.sh <requester-address>` does steps 1 to 4 below against the
live gateway, store and Escrow, without the planner, and reports PASS only if the task ends `Returned` with verdict
`Invalid`. Run it where `deploy/secrets/testnet.env` and `../mergit-contracts/.env.services` exist; it reads the tokens and
the agent key without printing them. `DRY_RUN=1` builds and checks the forgery locally and sends nothing. Use a fresh
requester address (`cast wallet new`, keep only the address): the plan is funded from that address's free credits.

1. Fund a plan and have the gateway lock one task for an agent whose runtime key you hold (on testnet, a seeded
   agent; locally, any agent from `SeedAgents`). Note the task id, plan id and agent id.
2. Build the false receipt:

   ```bash
   cargo run -p mergit-receipt --features forgery-fixture --example false_receipt -- \
     --task <task_id> --plan <plan_id> --agent <agent_id> --requester <requester address> \
     --key <the agent's runtime key> --chain-id 84532 --registry <ReceiptRegistry address> --out /tmp/false
   ```

   Check it first: `cargo run -p mergit-verifier -- /tmp/false/bundle.json --chain-id 84532 --registry <address>`
   prints `invalid` with `PHI_RESULT_CONTRADICTED`.
3. Upload and announce it, exactly as a worker would:

   ```bash
   curl -X PUT "$STORE_URL/v0/bundles" -H "authorization: Bearer $STORE_WRITE_TOKEN" \
     -H 'content-type: application/json' --data @/tmp/false/bundle.json
   curl -X POST "$GATEWAY_URL/v0/events" -H "authorization: Bearer $EVENTS_TOKEN" \
     -H 'content-type: application/json' --data @/tmp/false/receipt-sealed.json
   ```

4. Expect: `ReceiptCommitted` (the signature is genuine, so the chain accepts the commitment), then the validator
   records `invalid` (`VerdictRecorded`, verdict 3) and `TaskReturned` with reason 1: the money goes back to the
   plan. The proof page shows "Invalid receipt" and "The recorded result contradicts the evidence".

The `forgery-fixture` feature that builds this exists only for tests and this check; no service, binding or image
enables it.
