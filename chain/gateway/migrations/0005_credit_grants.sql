-- Credits are keyed by a ledger key: an address for old rows, or an account id (the control plane's user id) when
-- the control plane names one in `credit_account`. The column keeps its name, `address`, for the rows that exist.

-- Credit added to an account by something other than the default grant (a redeem code). `ref` is what makes a
-- grant idempotent: the control plane sends the code's id, and a redelivered event adds nothing.
create table credit_grants (
    ref text primary key,
    account text not null,
    amount bigint not null check (amount > 0),
    created_at timestamptz not null default now()
);
