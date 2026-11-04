-- `task_outcomes` (0015) counted only audited outcomes. The paper (§8.2) also counts an outcome that "was
-- challenged and adjudicated", and dropping those lost evidence: an unaudited task overturned by a challenge, or
-- one whose challenge failed and which was then paid, never reached a posterior. Same columns, same meaning; the
-- audited cases keep exactly the row they had.
--   failure: the validator's verdict was fail or invalid (at the first such verdict); or a challenge against the
--            task was upheld (the adjudicated outcome replaces the audit's). A passed and released task keeps
--            the release's position; otherwise the upheld resolution is what made it count, so it sits there
--   success: no fail/invalid verdict, no upheld challenge, the task was released, and it was either audited
--            (a pass verdict: at the release) or challenged and the challenge rejected (at the later of the
--            release and the rejection, the event that completed the evidence)
-- Still not evidence: a release nobody audited or challenged, a deadline return, a bare receipt, a pass verdict
-- with no release, and a rejected challenge with no release yet.
CREATE OR REPLACE VIEW task_outcomes AS
SELECT d.task_id,
       d.agent_id,
       p.category,
       p.funding,
       (bad.id IS NULL AND upheld.id IS NULL) AS success,
       CASE
           WHEN bad.id IS NOT NULL THEN bad.id
           WHEN passed.id IS NOT NULL AND rel.id IS NOT NULL THEN rel.id
           WHEN upheld.id IS NOT NULL THEN upheld.id
           ELSE GREATEST(rel.id, rejected.id)
       END AS position,
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
LEFT JOIN LATERAL (
    SELECT id FROM money_events
    WHERE task_id = d.task_id AND kind = 'challenge.resolved' AND NOT upheld
    ORDER BY id LIMIT 1) rejected ON true
LEFT JOIN task_costs c ON c.task_id = d.task_id
WHERE bad.id IS NOT NULL
   OR upheld.id IS NOT NULL
   OR (rel.id IS NOT NULL AND (passed.id IS NOT NULL OR rejected.id IS NOT NULL));
