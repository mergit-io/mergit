-- A dispatch's outbox row, by the task_id its payload names. `outcomes.stuck_indexes` and `runs.pending_dispatches`
-- join `task_dispatches` to the outbox on it for every plan detail and every running plan in the plan list, and the
-- run page reloads the detail while a retry waits; outbox rows are never deleted, so without this each lookup scans
-- the whole outbox.
CREATE INDEX outbox_dispatch_task ON outbox ((body->'payload'->>'task_id')) WHERE type = 'task.dispatch_requested';
