-- The job's attested cost: equal to the `cost_micros` of its `receipt.sealed` event, the same figure
-- the chain gateway and the receipt itself carry (invariant 3: metering happens inside the attested
-- runtime, so this is the attested figure, not a separate guess).
ALTER TABLE jobs ADD COLUMN cost_micros bigint CHECK (cost_micros >= 0);
