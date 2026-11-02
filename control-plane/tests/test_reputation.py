"""Costs are read from the gateway, posteriors are folded from counted outcomes, and a rebuild always agrees.

Run with `pytest -m postgres`.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
import psycopg
import pytest
from psycopg.rows import dict_row

from mergit_cp.config import Settings
from mergit_cp.db import Pool, migrate, open_pool
from mergit_cp.reputation import GatewayCosts, ReputationUpdater, record_missing_costs, refresh_posteriors
from mergit_cp.reputation_model import Params, Posterior
from tests.test_api import seed_plan
from tests.test_money import receive, tx
from tests.test_reputation_outcomes import challenge, released, verdict

pytestmark = pytest.mark.postgres
REQUESTER = "0x" + "1" * 40


def run(database_url: str, body: Callable[[Pool], Awaitable[None]]) -> None:
    """Like the other ledger tests, but on an emptied database: the posteriors are global, so a neighbour's
    outcomes would otherwise be in them."""

    async def go() -> None:
        pool = await open_pool(database_url, 4)
        try:
            async with pool.connection() as conn:
                await migrate(conn)
                cur = await conn.execute(
                    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
                    " AND tablename <> 'schema_migrations'"
                )
                tables = [r[0] for r in await cur.fetchall()]
                await conn.execute("TRUNCATE " + ", ".join(tables) + " CASCADE")
            await body(pool)
        finally:
            await pool.close()

    asyncio.run(go())


def gateway(costs: dict[str, str] | None = None, status: int = 200, raw: Any = None) -> GatewayCosts:
    """A gateway that answers ``?task_id=`` from ``costs`` (task id -> cost_micros)."""

    def handle(request: httpx.Request) -> httpx.Response:
        if status != 200:
            return httpx.Response(status)
        if raw is not None:
            return httpx.Response(200, json=raw)
        known = costs or {}
        task_id = request.url.params["task_id"]
        if task_id not in known:
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=[{"task_id": task_id, "cost_micros": known[task_id]}])

    return GatewayCosts(
        "http://gateway.test", client=httpx.AsyncClient(transport=httpx.MockTransport(handle))
    )


async def posteriors(pool: Pool) -> dict[tuple[str, str], dict[str, Any]]:
    async with pool.connection() as conn:
        cur = conn.cursor(row_factory=dict_row)
        await cur.execute("SELECT * FROM agent_posteriors")
        return {(r["agent_id"], r["category"]): r for r in await cur.fetchall()}


def prior(settings: Settings) -> Posterior:
    return Posterior.prior(Params(tau0=float(settings.reputation_cost_prior_micros)))


def test_posteriors_are_the_decayed_fold_of_counted_outcomes_in_order(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, tasks[0], "pass", "1")
        await released(pool, settings, tasks[0], "2")
        await verdict(pool, settings, tasks[1], "fail", "3")
        costs = gateway({tasks[0]: "400000", tasks[1]: "600000"})
        assert await record_missing_costs(pool, costs) == 2
        assert await refresh_posteriors(pool, settings) == 1

        expected = prior(settings).observe(True, 400000.0).observe(False, 600000.0)
        got = (await posteriors(pool))[("1", "test-repair")]
        for name in ("alpha", "beta", "kappa", "tau"):
            assert got[name] == pytest.approx(getattr(expected, name))
        assert got["n"] == 2

    run(database_url, body)


def test_an_outcome_whose_cost_is_not_known_yet_waits_and_is_never_taken_as_free(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, tasks[0], "fail", "1")
        # The gateway has not seen the commitment (empty list), is down, or answers nonsense.
        for costs in (gateway({}), gateway(status=503), gateway(raw={"not": "a list"}), gateway(raw=[{}])):
            assert await record_missing_costs(pool, costs) == 0
        await refresh_posteriors(pool, settings)
        assert await posteriors(pool) == {}
        async with pool.connection() as conn:
            cur = await conn.execute("SELECT count(*) FROM task_costs WHERE task_id = %s", (tasks[0],))
            row = await cur.fetchone()
            assert row is not None and row[0] == 0

        assert await record_missing_costs(pool, gateway({tasks[0]: "250000"})) == 1
        await refresh_posteriors(pool, settings)
        assert ("1", "test-repair") in await posteriors(pool)

    run(database_url, body)


def test_a_gateway_answer_for_another_task_or_a_negative_cost_is_refused(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, tasks[0], "fail", "1")
        other = [{"task_id": "0x" + "9" * 64, "cost_micros": "1"}]
        assert await record_missing_costs(pool, gateway(raw=other)) == 0
        assert await record_missing_costs(pool, gateway({tasks[0]: "-5"})) == 0

    run(database_url, body)


def test_work_funded_from_free_credits_never_moves_a_posterior(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        plan_uuid, _, tasks = await seed_plan(pool, requester=REQUESTER)
        async with pool.connection() as conn:
            await conn.execute("UPDATE plans SET funding = 'credits' WHERE plan_uuid = %s", (plan_uuid,))
        await verdict(pool, settings, tasks[0], "pass", "1")
        await released(pool, settings, tasks[0], "2")
        await verdict(pool, settings, tasks[1], "fail", "3")
        await record_missing_costs(pool, gateway({tasks[0]: "1", tasks[1]: "1"}))
        assert await refresh_posteriors(pool, settings) == 0
        assert await posteriors(pool) == {}
        async with pool.connection() as conn:  # the outcomes are recorded and visible, just not counted
            cur = await conn.execute("SELECT count(*) FROM task_outcomes WHERE funding = 'credits'")
            row = await cur.fetchone()
            assert row is not None and row[0] == 2

    run(database_url, body)


def test_an_upheld_challenge_changes_the_posterior_the_same_way_a_rebuild_would(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, tasks[0], "pass", "1")
        await released(pool, settings, tasks[0], "2")
        await record_missing_costs(pool, gateway({tasks[0]: "400000"}))
        await refresh_posteriors(pool, settings)
        before = (await posteriors(pool))[("1", "test-repair")]
        assert before["alpha"] == pytest.approx(prior(settings).observe(True, 400000.0).alpha)

        await challenge(pool, settings, tasks[0], upheld=True, t="3")
        await refresh_posteriors(pool, settings)
        after = (await posteriors(pool))[("1", "test-repair")]
        expected = prior(settings).observe(False, 400000.0)  # one outcome, now a failure, not two
        assert (after["alpha"], after["beta"], after["n"]) == (
            pytest.approx(expected.alpha),
            pytest.approx(expected.beta),
            1,
        )

    run(database_url, body)


def test_a_rebuild_agrees_with_the_incremental_refreshes(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER, n_tasks=3)
        costs = gateway({t: str(100000 * (i + 1)) for i, t in enumerate(tasks)})
        for i, task in enumerate(tasks):
            await verdict(pool, settings, task, "fail" if i == 1 else "pass", str(i))
            if i != 1:
                await released(pool, settings, task, "abc"[i])
            await record_missing_costs(pool, costs)
            await refresh_posteriors(pool, settings)  # one refresh after every outcome
        incremental = await posteriors(pool)
        async with pool.connection() as conn:
            await conn.execute("DELETE FROM agent_posteriors")
        await refresh_posteriors(pool, settings)
        rebuilt = await posteriors(pool)
        assert rebuilt.keys() == incremental.keys()
        for key, row in rebuilt.items():
            for name in ("alpha", "beta", "kappa", "tau", "n"):
                assert row[name] == pytest.approx(incremental[key][name])

    run(database_url, body)


def test_a_refresh_does_not_touch_the_task_graph(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, tasks[0], "fail", "1")
        await receive(pool, settings, "receipt.committed", {"task_id": tasks[1], "tx": tx("2")})

        async def snapshot() -> list[Any]:
            async with pool.connection() as conn:
                out: list[Any] = []
                for table in ("plans", "tasks", "task_dispatches", "jobs"):
                    cur = await conn.execute(f"SELECT * FROM {table} ORDER BY 1, 2")
                    out.append(await cur.fetchall())
                return out

        before = await snapshot()
        await record_missing_costs(pool, gateway({tasks[0]: "1"}))
        await refresh_posteriors(pool, settings)
        assert await snapshot() == before

    run(database_url, body)


def scripted(answer: Callable[[str], httpx.Response], asked: list[str]) -> GatewayCosts:
    """A gateway whose answer for each task id is ``answer(task_id)``; every task asked about is appended to
    ``asked``. ``answer`` may raise an ``httpx`` error to play an unreachable gateway."""

    def handle(request: httpx.Request) -> httpx.Response:
        task_id = request.url.params["task_id"]
        asked.append(task_id)
        return answer(task_id)

    return GatewayCosts(
        "http://gateway.test", client=httpx.AsyncClient(transport=httpx.MockTransport(handle))
    )


def commitment(task_id: str, cost: str) -> httpx.Response:
    return httpx.Response(200, json=[{"task_id": task_id, "cost_micros": cost}])


async def fail_each(pool: Pool, settings: Settings, tasks: list[str]) -> None:
    """A validated failure for each task, in order."""
    for i, task in enumerate(tasks):
        await receive(
            pool, settings, "verdict.recorded", {"task_id": task, "verdict": "fail", "tx": f"0x{i + 1:064x}"}
        )


async def recorded(pool: Pool) -> set[str]:
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT task_id FROM task_costs")
        return {r[0] for r in await cur.fetchall()}


def test_outcomes_whose_cost_never_arrives_do_not_hold_back_newer_ones(database_url: str, settings: Settings):
    """The review's case: 51 validated failures, and the gateway knows only the newest one's commitment. The
    50 older ones used to fill every slot of every pass, so the 51st was never asked about."""

    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER, n_tasks=51)
        await fail_each(pool, settings, tasks)
        asked: list[str] = []
        newest = tasks[-1]
        costs = scripted(
            lambda t: commitment(t, "300000") if t == newest else httpx.Response(200, json=[]), asked
        )
        assert await record_missing_costs(pool, costs) == 1
        assert await recorded(pool) == {newest}
        assert asked == tasks  # every pending outcome was tried, oldest first, in one pass
        assert await refresh_posteriors(pool, settings) == 1

    run(database_url, body)


def test_an_unusable_answer_for_one_task_does_not_stop_the_others(database_url: str, settings: Settings):
    """Another task's commitment, a negative cost, a row that is not an object (D11), a cost that is not a
    number, a 400: each is that task's problem. The task after them still gets its cost."""

    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER, n_tasks=6)
        await fail_each(pool, settings, tasks)
        bad = {
            tasks[0]: httpx.Response(200, json=[{"task_id": "0x" + "9" * 64, "cost_micros": "1"}]),
            tasks[1]: commitment(tasks[1], "-5"),
            tasks[2]: httpx.Response(200, json=["x"]),
            tasks[3]: commitment(tasks[3], "lots"),
            tasks[4]: httpx.Response(400),
        }
        asked: list[str] = []
        costs = scripted(lambda t: bad.get(t) or commitment(t, "200000"), asked)
        assert await record_missing_costs(pool, costs) == 1
        assert await recorded(pool) == {tasks[5]}
        assert asked == tasks

    run(database_url, body)


def gateway_cannot_answer(
    database_url: str, settings: Settings, answer: Callable[[str], httpx.Response]
) -> None:
    """Every task would fail the same way, so the rest are left for the next pass rather than each asked."""

    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER, n_tasks=3)
        await fail_each(pool, settings, tasks)
        asked: list[str] = []
        assert await record_missing_costs(pool, scripted(answer, asked)) == 0
        assert asked == tasks[:1]
        assert await recorded(pool) == set()

    run(database_url, body)


def _unreachable(task_id: str) -> httpx.Response:
    raise httpx.ConnectError(f"refused while asking about {task_id}")


@pytest.mark.parametrize(
    ("status", "content"),
    [(503, b"[]"), (429, b"[]"), (401, b"[]"), (200, b"<html>not json</html>"), (200, b'{"not": "a list"}')],
    ids=["503", "429", "401", "not-json", "not-a-list"],
)
def test_a_gateway_that_cannot_answer_ends_the_pass_after_one_request(
    database_url: str, settings: Settings, status: int, content: bytes
):
    gateway_cannot_answer(database_url, settings, lambda _: httpx.Response(status, content=content))


def test_an_unreachable_gateway_ends_the_pass_after_one_request(database_url: str, settings: Settings):
    gateway_cannot_answer(database_url, settings, _unreachable)


def test_a_cost_another_instance_recorded_first_is_not_counted_as_written(
    database_url: str, settings: Settings
):
    """Two API instances read the same pending task; the other one's INSERT lands first, ours does nothing."""

    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, tasks[0], "fail", "1")

        def raced(task_id: str) -> httpx.Response:
            with psycopg.connect(database_url) as conn:
                conn.execute("INSERT INTO task_costs (task_id, cost_micros) VALUES (%s, 7)", (task_id,))
            return commitment(task_id, "7")

        assert await record_missing_costs(pool, scripted(raced, [])) == 0
        assert await recorded(pool) == {tasks[0]}

    run(database_url, body)


def test_a_commitment_that_is_not_an_object_does_not_skip_the_refresh(database_url: str, settings: Settings):
    """A gateway row that is not a dict used to raise AttributeError, which escaped the pass before the
    posteriors were refreshed."""

    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, tasks[0], "fail", "1")
        await record_missing_costs(pool, gateway({tasks[0]: "300000"}))
        await verdict(pool, settings, tasks[1], "fail", "2")
        await ReputationUpdater(pool, settings, gateway(raw=["x"])).update()
        assert (await posteriors(pool))[("1", "test-repair")]["n"] == 1

    run(database_url, body)


def test_a_zero_cost_outcome_still_counts_as_a_success_or_failure_but_not_as_a_cost(
    database_url: str, settings: Settings
):
    """Paper §8.3's c > 0 constrains only the cost (Gamma) update; the success (Beta) update of §8.2 has no
    cost precondition. A validated failure whose receipt metered 0 (say, a run that died before its first
    billed call) is still a failure, so it moves beta and n; it says nothing about cost, so kappa and tau skip
    it. A positive cost folds as before; free-credit work and outcomes whose cost is pending stay out."""

    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER, n_tasks=4)
        zero, paid, pending, free_zero = tasks
        await fail_each(pool, settings, [zero, paid, pending])
        credits_uuid, _, credit_tasks = await seed_plan(pool, requester=REQUESTER, n_tasks=1)
        async with pool.connection() as conn:
            await conn.execute("UPDATE plans SET funding = 'credits' WHERE plan_uuid = %s", (credits_uuid,))
        await receive(
            pool,
            settings,
            "verdict.recorded",
            {"task_id": credit_tasks[0], "verdict": "fail", "tx": f"0x{99:064x}"},
        )
        del free_zero  # never validated: no row at all
        costs = gateway({zero: "0", paid: "300000", credit_tasks[0]: "0"})  # `pending` is not known yet
        assert await record_missing_costs(pool, costs) == 3
        assert await refresh_posteriors(pool, settings) == 1

        got = (await posteriors(pool))[("1", "test-repair")]
        expected = prior(settings).observe(False, None).observe(False, 300000.0)  # in ledger order
        assert got["n"] == 2  # the zero-cost failure counts; the pending one and the credits one do not
        for name in ("alpha", "beta", "kappa", "tau"):
            assert got[name] == pytest.approx(getattr(expected, name))
        # beta saw two failures; kappa and tau saw one cost (and one decay before it, from the prior only)
        assert got["beta"] == pytest.approx(0.95 * (0.95 * 1 + 1) + 1)
        assert got["kappa"] == pytest.approx(0.95 * 1 + 1)
        assert got["tau"] == pytest.approx(0.95 * settings.reputation_cost_prior_micros + 300000)

    run(database_url, body)


def test_record_missing_costs_stops_at_the_batch_size(database_url: str, settings: Settings):
    """Without a cap, a backlog of pending outcomes (an outage, or heavy volume) makes one pass make one
    sequential gateway request per task with no bound; a request is required on every poll on top of
    whatever the pass is still working through, so the backlog never shrinks."""

    def body_with(n: int, batch: int) -> Callable[[Pool], Awaitable[None]]:
        async def body(pool: Pool) -> None:
            _, _, tasks = await seed_plan(pool, requester=REQUESTER, n_tasks=n)
            for i, task in enumerate(tasks):
                await verdict(pool, settings, task, "pass", f"{i:x}")
                await released(pool, settings, task, f"{i + 8:x}")
            costs = gateway({t: "100000" for t in tasks})
            assert await record_missing_costs(pool, costs, batch=batch) == min(n, batch)

        return body

    run(database_url, body_with(5, 2))


def test_record_missing_costs_stops_at_the_time_budget(database_url: str, settings: Settings):
    """A gateway that answers, but slowly, must not make one pass run arbitrarily long either; the rest
    wait for the next poll, same as hitting the batch cap."""

    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER, n_tasks=3)
        for i, task in enumerate(tasks):
            await verdict(pool, settings, task, "pass", f"{i:x}")
            await released(pool, settings, task, f"{i + 8:x}")

        def handle(request: httpx.Request) -> httpx.Response:
            task_id = request.url.params["task_id"]
            return httpx.Response(200, json=[{"task_id": task_id, "cost_micros": "100000"}])

        costs = GatewayCosts(
            "http://gateway.test", client=httpx.AsyncClient(transport=httpx.MockTransport(handle))
        )
        written = await record_missing_costs(pool, costs, batch=100, budget_s=0.0)
        assert written == 0  # the budget is spent before the first request is even tried

    run(database_url, body)


def test_the_updater_passes_its_settings_batch_and_budget(
    database_url: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
):
    s = settings.model_copy(update={"reputation_cost_batch": 3, "reputation_cost_budget_s": 7.0})
    seen: dict[str, Any] = {}

    async def fake(pool: Pool, costs: GatewayCosts, *, batch: int, budget_s: float) -> int:
        seen["batch"], seen["budget_s"] = batch, budget_s
        return 0

    import mergit_cp.reputation as reputation_module

    monkeypatch.setattr(reputation_module, "record_missing_costs", fake)

    async def body(pool: Pool) -> None:
        await ReputationUpdater(pool, s, gateway()).update()

    run(database_url, body)
    assert seen == {"batch": 3, "budget_s": 7.0}
