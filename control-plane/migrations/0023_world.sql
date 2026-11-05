-- One row per human per IDKit action. No FK cascade: deleting the account must not free the nullifier.
CREATE TABLE world_nullifiers (
    action      text          NOT NULL,
    nullifier   numeric(78,0) NOT NULL,
    user_id     uuid          REFERENCES users ON DELETE SET NULL,
    credential  text          NOT NULL,
    environment text          NOT NULL,
    verified_at timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (action, nullifier)
);
CREATE UNIQUE INDEX world_nullifiers_one_per_user ON world_nullifiers (action, user_id) WHERE user_id IS NOT NULL;

-- The World IdP subject (pairwise `sub`) that approves for an account. One human, one account.
CREATE TABLE world_links (
    user_id   uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
    sub       text NOT NULL UNIQUE,
    linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE world_approvals (
    approval_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('approve_plan', 'open_pr')),
    plan_uuid    uuid NOT NULL,
    action_hash  text NOT NULL,             -- sha256 hex of the canonical action JSON
    summary      jsonb NOT NULL,            -- what the dialog showed the human
    state        text UNIQUE,               -- OIDC state; NULL until /start
    nonce        text,
    code_verifier text,
    status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'denied', 'failed', 'consumed')),
    reason       text,                      -- why denied/failed (shown to the user, logged)
    sub          text,
    acr          text,
    auth_time    timestamptz,
    jti          text UNIQUE,               -- ID token id: a token approves once
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    decided_at   timestamptz,
    consumed_at  timestamptz
);
CREATE INDEX world_approvals_user ON world_approvals (user_id, created_at DESC);
