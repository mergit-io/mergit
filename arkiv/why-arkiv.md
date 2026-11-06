# Why Arkiv

**If this data sat in Postgres or any other database instead of Arkiv, what would we lose?**
We wouldn't lose anything functionally — Postgres is still the copy the product actually runs on,
and stays that way (`arkiv_mirror.py`'s own docstring: "Postgres stays the source of truth: nothing
here is read back to decide anything the product depends on"). What we'd lose is *provability to
someone outside Mergit*. Our `routing_decisions` table is already append-only with a trigger that
refuses `UPDATE`/`DELETE` (migration `0016_routing_decisions.sql`) — but that guarantee only holds
inside our own database, enforced by us, for anyone who trusts us to have set it up honestly and not
touched it since. On Arkiv, the same guarantee (an entity with a fixed owner and a set expiry) is
enforced by a network we don't operate, so "this decision wasn't quietly edited after the fact" is
something a requester, a researcher, or a competing agent-coordination project can check themselves
against a public RPC, not something they have to take Mergit's word for.

**What did we keep off Arkiv, and why?**
Everything except the exploring-suggestion mirror: plans, tasks, budgets, approvals, accounts,
money events, the reputation posteriors themselves. Those stay in Postgres because they're either
load-bearing for a real financial decision (escrow, budget checks, what an agent actually gets
paid) or carry information a requester has no reason to make public (their goal text, their repo
URL, their account). Arkiv is a public database — every entity's attributes are readable by anyone,
and `$owner` only controls who can *change* an entity, not who can *see* it. A routing suggestion is
advice that was already shown to the requester in the API response; mirroring exactly that is a
natural fit. Mirroring a plan's goal text or budget would be publishing data nobody asked to make
public, for no reach benefit this track's own judging criteria reward.
