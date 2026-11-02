-- One row per exploring suggestion (GET /v0/plans/{uuid}/suggestions?explore=true), for the per-requester rate
-- limit. Each one appends a replay record per task to `routing_decisions` (0016), which is append-only, so
-- without a limit anyone with a draft plan could grow it without bound. A greedy suggestion writes nothing and is
-- not counted. The same shape as `planning_attempts` (0003), which limits the planner the same way.
CREATE TABLE suggestion_attempts (
    requester   text NOT NULL,
    at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX suggestion_attempts_requester ON suggestion_attempts (requester, at DESC);
