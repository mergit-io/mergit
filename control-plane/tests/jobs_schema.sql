-- The columns the worker reads and writes, as plan tasks O3 and O4 create them. This is the contract:
-- if the real migrations rename or retype any of these, tests/test_jobs.py fails and `mergit_worker/jobs.py`
-- gets updated in the same change. Columns the worker adds to `jobs` are marked.
CREATE TABLE plans (
    plan_uuid uuid PRIMARY KEY,
    plan_id text NOT NULL,
    requester text NOT NULL,
    repo_url text NOT NULL,
    ref text NOT NULL,
    category text NOT NULL,
    goal text NOT NULL DEFAULT '',          -- O3
    state text NOT NULL DEFAULT 'draft'     -- O3/O6: draft | approved | funded | running | done | failed | closed
);

CREATE TABLE tasks (
    plan_uuid uuid NOT NULL REFERENCES plans,
    "index" integer NOT NULL,
    title text NOT NULL,
    instructions text NOT NULL,
    phi jsonb NOT NULL,
    budget_usdc_units bigint NOT NULL,
    depends_on integer[] NOT NULL DEFAULT '{}',  -- O3
    PRIMARY KEY (plan_uuid, "index")
);

CREATE TABLE jobs (
    task_id text PRIMARY KEY,
    plan_uuid uuid NOT NULL REFERENCES plans,
    "index" integer NOT NULL,
    attempt integer NOT NULL,
    agent_id text NOT NULL,
    status text NOT NULL DEFAULT 'queued',  -- queued | running | done | error
    created_at timestamptz NOT NULL DEFAULT now(),
    claimed_by text,        -- worker
    claimed_at timestamptz, -- worker
    phi_holds boolean,      -- worker; NULL while unfinished, and when Φ was inconclusive
    receipt_root text,      -- worker
    notes text,             -- worker
    patch text,             -- worker; the change of a task that passed Φ, NULL otherwise
    cost_micros bigint,     -- worker; the sealed bundle's attested cost, NULL when the task never sealed
    finished_at timestamptz -- worker
);
