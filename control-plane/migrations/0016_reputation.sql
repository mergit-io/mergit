-- Cost-adjusted reputation (paper 8.2-8.8): the append-only observation log, and the posterior rows
-- folded from it.
--
-- `reputation_observations` is built from two sources money and the job ledger already carry: a
-- validated verdict (`money_events.kind = 'verdict.recorded'`, `verdict IN ('pass', 'fail')`) is an
-- `outcome`; a sealed job's attested cost (`jobs.cost_micros > 0 AND jobs.receipt_root IS NOT NULL`) is a
-- `cost`; a proven false receipt (`verdict.recorded` with `verdict = 'invalid'`, or `challenge.resolved`
-- with `upheld = true`) is a `falsification` -- never a capability update, only a probation signal (paper
-- 7.5 iii). One row per observed fact (`UNIQUE (kind, task_id)`), append-only like `money_events`.
--
-- `reputation_posteriors` holds the current Beta x Gamma posterior per (agent, category); `category = '*'`
-- is the agent-level (not category-specific) row. `reputation_applied` is a single row tracking how far the
-- observation log has been folded into these posteriors -- `mergit_cp/reputation.py`'s `ingest_due` takes
-- `pg_advisory_xact_lock(hashtext('mergit.reputation'))` before reading and advancing it, so concurrent
-- updaters serialise rather than double-apply the same observation.

CREATE TABLE reputation_observations (
    id bigserial PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('outcome', 'cost', 'falsification')),
    task_id text NOT NULL,
    agent_id text NOT NULL,
    operator text NOT NULL,
    category text NOT NULL,
    requester text NOT NULL,
    success boolean,
    cost_micros bigint CHECK (cost_micros > 0),
    weight double precision,
    observed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, task_id),
    -- Each kind carries exactly its own fields and no others.
    CONSTRAINT reputation_observations_shape CHECK (CASE kind
        WHEN 'outcome' THEN success IS NOT NULL AND weight IS NOT NULL AND cost_micros IS NULL
        WHEN 'cost' THEN cost_micros IS NOT NULL AND success IS NULL AND weight IS NULL
        WHEN 'falsification' THEN success IS NULL AND weight IS NULL AND cost_micros IS NULL
        ELSE false
    END)
);

CREATE INDEX reputation_observations_agent_category ON reputation_observations (agent_id, category, id);

-- `in_probation` (mergit_cp/reputation.py) looks up falsifications by operator within a recent window.
CREATE INDEX reputation_observations_operator_falsification
    ON reputation_observations (operator, observed_at) WHERE kind = 'falsification';

CREATE FUNCTION reputation_observations_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'reputation_observations is append-only';
END
$$;

CREATE TRIGGER reputation_observations_append_only BEFORE UPDATE OR DELETE ON reputation_observations
    FOR EACH ROW EXECUTE FUNCTION reputation_observations_append_only();
-- Deliberately not also BEFORE TRUNCATE: this fires for every row-level UPDATE/DELETE an application
-- role could issue, which is the real risk. TRUNCATE needs table-owner privilege the application role
-- isn't granted, and the test suite's own global per-test reset (conftest.py's `client` fixture)
-- legitimately truncates every public table, including this one, between tests.

CREATE TABLE reputation_posteriors (
    agent_id text NOT NULL,
    category text NOT NULL,
    alpha double precision NOT NULL,
    beta double precision NOT NULL,
    kappa double precision NOT NULL,
    tau double precision NOT NULL,
    outcomes integer NOT NULL DEFAULT 0,
    costs integer NOT NULL DEFAULT 0,
    PRIMARY KEY (agent_id, category)
);

CREATE TABLE reputation_applied (
    one boolean PRIMARY KEY DEFAULT true CHECK (one),
    last_id bigint NOT NULL
);

INSERT INTO reputation_applied (one, last_id) VALUES (true, 0);
