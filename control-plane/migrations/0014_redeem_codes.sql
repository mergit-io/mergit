-- Redeem codes: a one-time code that adds credit to the account that redeems it. Only a keyed hash of the code is
-- stored, so a copy of this table reveals no code. A code is claimed with one UPDATE (redeemed_at IS NULL), so two
-- people redeeming at once cannot both win.
CREATE TABLE redeem_codes (
    code_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash         bytea NOT NULL UNIQUE,
    amount_usdc_units bigint NOT NULL CHECK (amount_usdc_units BETWEEN 1 AND 1000000000000),
    note              text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz,
    revoked_at        timestamptz,
    -- No foreign key: who redeemed a code is history that must outlive a merged or deleted account.
    redeemed_by       uuid,
    redeemed_at       timestamptz,
    CHECK ((redeemed_by IS NULL) = (redeemed_at IS NULL))
);

-- Every attempt, right or wrong, so guessing is rate limited per account.
CREATE TABLE redeem_attempts (
    user_id uuid NOT NULL,
    at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX redeem_attempts_user ON redeem_attempts (user_id, at);
