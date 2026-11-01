-- Cost-adjusted reputation (paper §8), derived from the money ledger. Nothing here is written by hand: the
-- outcomes are a view over `money_events`, the costs are the gateway's on-chain commitments copied once, and the
-- posteriors are a cache that can be thrown away and rebuilt from the other two.

-- What a finished task cost, as committed on chain (the gateway's `commitments.cost_micros`, which the runtime
-- metered). Written once per task: a commitment cannot change, so a second write is a bug, not an update.
CREATE TABLE task_costs (
    task_id     text PRIMARY KEY REFERENCES task_dispatches (task_id),
    cost_micros numeric(78, 0) NOT NULL CHECK (cost_micros >= 0),   -- USDC micros, as the receipt reports it
    recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION task_costs_write_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'task_costs is write-once';
END
$$;

CREATE TRIGGER task_costs_write_once BEFORE UPDATE OR DELETE ON task_costs
    FOR EACH ROW EXECUTE FUNCTION task_costs_write_once();

-- One row per task whose outcome is validated (invariant 4), with what it is and where it sits in time.
--   failure: the validator's verdict was fail or invalid; or the task passed and was released, and a challenge
--            against it was then upheld (the adjudicated outcome replaces the audit's)
--   success: a pass verdict and a release, and no upheld challenge
-- Not evidence, so absent: a task released with no verdict (unaudited), one returned at its deadline (never
-- delivered, never audited), and anything with only a receipt. `position` is the ledger id of the event that
-- made the outcome count, so replaying the ledger in order always gives the same posterior.
-- `funding` is carried so faucet-tier work (invariant 6) can be stored and shown but kept out of every posterior.
CREATE VIEW task_outcomes AS
SELECT d.task_id,
       d.agent_id,
       p.category,
       p.funding,
       (bad.id IS NULL AND upheld.id IS NULL) AS success,
       COALESCE(bad.id, rel.id) AS position,
       c.cost_micros
FROM task_dispatches d
JOIN plans p ON p.plan_uuid = d.plan_uuid
LEFT JOIN LATERAL (
    SELECT id FROM money_events
    WHERE task_id = d.task_id AND kind = 'verdict.recorded' AND verdict IN ('fail', 'invalid')
    ORDER BY id LIMIT 1) bad ON true
LEFT JOIN LATERAL (
    SELECT id FROM money_events
    WHERE task_id = d.task_id AND kind = 'verdict.recorded' AND verdict = 'pass'
    ORDER BY id LIMIT 1) passed ON true
LEFT JOIN LATERAL (
    SELECT id FROM money_events
    WHERE task_id = d.task_id AND kind = 'task.released'
    ORDER BY id LIMIT 1) rel ON true
LEFT JOIN LATERAL (
    SELECT id FROM money_events
    WHERE task_id = d.task_id AND kind = 'challenge.resolved' AND upheld
    ORDER BY id LIMIT 1) upheld ON true
LEFT JOIN task_costs c ON c.task_id = d.task_id
WHERE bad.id IS NOT NULL OR (passed.id IS NOT NULL AND rel.id IS NOT NULL);

-- The cache: one row per agent and category, folded from `task_outcomes` in `position` order (reputation.py).
CREATE TABLE agent_posteriors (
    agent_id   text NOT NULL,
    category   text NOT NULL,
    alpha      double precision NOT NULL CHECK (alpha > 0),
    beta       double precision NOT NULL CHECK (beta > 0),
    kappa      double precision NOT NULL CHECK (kappa > 0),
    tau        double precision NOT NULL CHECK (tau > 0),
    n          integer NOT NULL CHECK (n >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, category)
);
