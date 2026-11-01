-- Routing eligibility and the recorded draw (paper 7.5): which agents may even be considered for an
-- auto-routed task (operator concurrency caps, probation, already-tried agents), and what Thompson draw
-- was made and why (`mergit_cp/routing.py`).
--
-- `tasks.routing` distinguishes a requester's manual agent picks (`'pick'`, the existing behaviour, kept
-- as the default so every row written before this migration stays a manual pick) from a task routed by
-- `mergit_cp/routing.py::route`. `explore`/`retry_tolerant` are per-task knobs into `mergit_cp.router.Mode`
-- (paper 9.3-9.4); they default true so an auto-routed task explores by default and assumes a retryable
-- failure, matching `Mode`'s own defaults.
--
-- `routing_draws` is one row per dispatch attempt that went through `route`: the seed (stored as text so
-- it round-trips exactly through Postgres and JSON, never as a double-precision float), the full sample
-- set and the ineligibility map (both jsonb, for audit/debugging), and what was actually chosen versus
-- what the deterministic greedy baseline would have picked. `exploratory` reflects the agent actually
-- dispatched (`chosen_agent`): a draw that sampled exploratory but was redirected to `greedy` because the
-- operator was already at its exploration cap is recorded with `exploratory = false`, honestly describing
-- what was dispatched, not what was originally sampled.

ALTER TABLE tasks
    ADD COLUMN routing text NOT NULL DEFAULT 'pick' CHECK (routing IN ('pick', 'auto')),
    ADD COLUMN explore boolean NOT NULL DEFAULT true,
    ADD COLUMN retry_tolerant boolean NOT NULL DEFAULT true;

CREATE TABLE routing_draws (
    task_id         text PRIMARY KEY REFERENCES task_dispatches (task_id),
    seed            text NOT NULL,
    explore         boolean NOT NULL,
    retry_tolerant  boolean NOT NULL,
    budget_micros   bigint NOT NULL,
    samples         jsonb NOT NULL,
    ineligible      jsonb NOT NULL,
    chosen_agent    text NOT NULL,
    greedy_agent    text,
    exploratory     boolean NOT NULL,
    drawn_at        timestamptz NOT NULL DEFAULT now()
);
