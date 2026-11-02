-- What a signed-in user chooses for themselves: how their plans are drafted and approved, and how much they let
-- themselves spend. Every column is nullable or has a default, so a user with no row behaves as before.
CREATE TABLE user_settings (
    user_id                 uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
    planner_model           text,      -- NULL: the deployment's model. Checked against the allowlist when saved
    routing_mode            text NOT NULL DEFAULT 'greedy' CHECK (routing_mode IN ('greedy', 'explore')),
    max_attempts            integer NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 3),
    default_funding         text NOT NULL DEFAULT 'credits' CHECK (default_funding IN ('credits', 'wallet')),
    per_plan_cap_usdc_units bigint CHECK (per_plan_cap_usdc_units > 0),   -- NULL: no cap
    daily_cap_usdc_units    bigint CHECK (daily_cap_usdc_units > 0),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- A deleted account leaves no user, but the free credits are once per person. This keeps an HMAC of each
-- sign-in method the deleted account had (never the method itself), so the same GitHub login or wallet coming
-- back cannot start a second trial. No foreign key: the user it names no longer exists.
CREATE TABLE deleted_methods (
    method_hash bytea PRIMARY KEY,
    deleted_at  timestamptz NOT NULL DEFAULT now()
);
