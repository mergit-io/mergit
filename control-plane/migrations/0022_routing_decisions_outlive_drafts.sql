-- `routing_decisions` (0016) is a replay log of exploring draws, and draws are only made for draft plans. A
-- draft can be discarded (DELETE /v0/plans/{uuid}), which really deletes the plan row, so the foreign key made
-- any draft that ever had a draw impossible to discard. The log is an audit record, not a live reference: it
-- should outlive the draft it was drawn for, so `plan_uuid` keeps its value (still NOT NULL) and stops
-- referencing `plans`. Cascading the delete would not work anyway, and would erase the record: the append-only
-- trigger, unchanged here, still refuses every UPDATE and DELETE on the log.
ALTER TABLE routing_decisions DROP CONSTRAINT IF EXISTS routing_decisions_plan_uuid_fkey;
