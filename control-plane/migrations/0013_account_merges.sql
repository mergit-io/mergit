-- One person, two accounts (say a wallet-only one and a GitHub one). A person who is signed in to one and has just
-- proved they hold the other's wallet can merge them, after confirming. The merged-away account is deleted; this
-- remembers which user it became, so its free-trial runs (their requester is a hash of the old user id) stay visible.
CREATE TABLE merged_users (
    old_user_id  uuid PRIMARY KEY,           -- no foreign key: that user no longer exists
    into_user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    merged_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX merged_users_into ON merged_users (into_user_id);

-- A one-time offer made when a wallet link finds the wallet on another account. Only a hash of the token is stored.
-- It names both accounts and the wallet, so it cannot be used for anything else.
CREATE TABLE pending_merges (
    token_hash  bytea PRIMARY KEY,
    keep_user   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    absorb_user uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    address     text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    CHECK (keep_user <> absorb_user)
);
