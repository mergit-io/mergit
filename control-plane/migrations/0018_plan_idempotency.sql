-- A retried or double-clicked POST /v0/plans names the same Idempotency-Key and gets the same draft back,
-- instead of paying the planner model for a second one. Scoped to the requester, so keys cannot collide
-- across people. Plans made without a key have none.
ALTER TABLE plans ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX plans_idempotency ON plans (requester, idempotency_key) WHERE idempotency_key IS NOT NULL;
