-- A task's ledger rows, by kind, oldest first. `task_outcomes` (0015) looks up each dispatch's first event of a
-- kind (`WHERE task_id = ? AND kind = ? ORDER BY id LIMIT 1`), and nothing else served that lookup: the only
-- index with `task_id` in it, `money_events_on_chain`, is partial (`tx IS NOT NULL`), so each lookup walked the
-- whole ledger and the view cost tasks x events. That view runs on every reputation pass and on every
-- `GET /v0/agents/reputation`, which needs no sign-in.
CREATE INDEX money_events_task ON money_events (task_id, kind, id);
