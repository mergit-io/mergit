-- Thompson draws made for a plan's tasks (paper §9.3), kept so any draw can be replayed from its seed and the
-- posteriors it saw. Only exploring suggestions are recorded: a greedy one is deterministic given the posteriors.
-- Suggestions are advice; the requester's approval (plans.tasks.agents) is what runs.

CREATE TABLE routing_decisions (
    decision_id bigserial PRIMARY KEY,
    plan_uuid   uuid NOT NULL REFERENCES plans,
    task_index  integer NOT NULL CHECK (task_index >= 0),
    category    text NOT NULL,
    seed        bigint NOT NULL,
    budget_micros bigint NOT NULL CHECK (budget_micros > 0),
    candidates  jsonb NOT NULL,  -- each agent's posterior as it stood: [{agent_id, alpha, beta, kappa, tau, n}]
    picks       jsonb NOT NULL,  -- the ordered answer: [{agent_id, score, success, cost}]
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX routing_decisions_plan ON routing_decisions (plan_uuid, decision_id);

CREATE FUNCTION routing_decisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'routing_decisions is append-only';
END
$$;

CREATE TRIGGER routing_decisions_append_only BEFORE UPDATE OR DELETE ON routing_decisions
    FOR EACH ROW EXECUTE FUNCTION routing_decisions_append_only();
