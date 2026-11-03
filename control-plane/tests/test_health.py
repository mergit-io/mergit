"""/healthz tells a proxy or a deploy script whether this API can serve (its database answers)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from mergit_cp import health

pytestmark = pytest.mark.postgres


def test_healthz_is_ok_when_the_database_answers(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_healthz_needs_no_session_and_leaks_nothing(client: TestClient) -> None:
    body = client.get("/healthz").text
    for word in ("version", "postgres", "password", "secret", "token"):
        assert word not in body.lower()


class _Conn:
    def __init__(self, hang: bool) -> None:
        self._hang = hang

    async def execute(self, _sql: str) -> None:
        if self._hang:
            await asyncio.sleep(60)
        raise OSError("connection refused")


class _BrokenPool:
    def __init__(self, hang: bool = False) -> None:
        self._hang = hang

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[_Conn]:
        yield _Conn(self._hang)


def _app_with(pool: object) -> FastAPI:
    app = FastAPI()
    app.state.pool = pool
    app.include_router(health.router)
    return app


def test_healthz_is_503_when_the_database_errors() -> None:
    with TestClient(_app_with(_BrokenPool())) as c:
        response = c.get("/healthz")
    assert response.status_code == 503
    assert response.json() == {"ok": False}
    assert "refused" not in response.text  # the error text stays in the log


def test_healthz_is_503_not_a_hang_when_the_database_stalls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(health, "DB_CHECK_TIMEOUT_S", 0.2)
    with TestClient(_app_with(_BrokenPool(hang=True))) as c:
        response = c.get("/healthz")
    assert response.status_code == 503


def test_the_database_probe_is_one_select(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    class Conn:
        async def execute(self, sql: str) -> None:
            seen.append(sql)

    class Pool:
        @asynccontextmanager
        async def connection(self) -> AsyncIterator[Conn]:
            yield Conn()

    asyncio.run(health._database_answers(cast(Any, Pool())))
    assert seen == ["SELECT 1"]


class _CountingPool:
    """A pool that records every checkout, how many are open at once, and can fail or hang."""

    def __init__(self, fail: bool = False, hang: bool = False) -> None:
        self.fail, self.hang = fail, hang
        self.checkouts = 0
        self.open_now = 0
        self.max_open = 0

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[_CountingPool]:
        self.checkouts += 1
        self.open_now += 1
        self.max_open = max(self.max_open, self.open_now)
        try:
            yield self
        finally:
            self.open_now -= 1

    async def execute(self, _sql: str) -> None:
        if self.hang:
            await asyncio.sleep(60)
        if self.fail:
            raise OSError("connection refused: password=hunter2")


def test_healthz_serves_a_cached_result_within_two_seconds(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1000.0]
    monkeypatch.setattr(health, "_now", lambda: now[0])
    pool = _CountingPool()
    with TestClient(_app_with(pool)) as c:
        assert c.get("/healthz").json() == {"ok": True}
        now[0] += 1.9
        assert c.get("/healthz").json() == {"ok": True}
        assert pool.checkouts == 1, "two calls inside 2 s must cost one database probe"
        now[0] += 0.2  # past the 2 s window: probe again
        assert c.get("/healthz").status_code == 200
        assert pool.checkouts == 2


def test_healthz_caches_a_failure_too(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1000.0]
    monkeypatch.setattr(health, "_now", lambda: now[0])
    pool = _CountingPool(fail=True)
    with TestClient(_app_with(pool)) as c:
        assert c.get("/healthz").status_code == 503
        assert c.get("/healthz").status_code == 503
    assert pool.checkouts == 1


def test_concurrent_healthz_requests_share_one_probe() -> None:
    pool = _CountingPool()

    async def run() -> list[int]:
        app = _app_with(pool)
        from httpx import ASGITransport, AsyncClient

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            responses = await asyncio.gather(*(c.get("/healthz") for _ in range(20)))
        return [r.status_code for r in responses]

    assert asyncio.run(run()) == [200] * 20
    assert pool.checkouts == 1


def test_healthz_failure_logs_without_a_traceback_flood(caplog: pytest.LogCaptureFixture) -> None:
    pool = _CountingPool(fail=True)
    with caplog.at_level("DEBUG", logger="mergit_cp.health"), TestClient(_app_with(pool)) as c:
        response = c.get("/healthz")
    assert response.status_code == 503
    assert response.json() == {"ok": False}
    records = [r for r in caplog.records if r.name == "mergit_cp.health"]
    assert records, "a failed probe must be logged"
    assert all(r.levelname == "WARNING" for r in records)
    assert all(r.exc_info is None for r in records), "no traceback per failure"
    assert "hunter2" not in response.text


def test_a_probe_that_hangs_returns_not_ok_and_holds_one_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(health, "DB_CHECK_TIMEOUT_S", 0.2)
    pool = _CountingPool(hang=True)

    async def run() -> list[int]:
        from httpx import ASGITransport, AsyncClient

        async with AsyncClient(transport=ASGITransport(app=_app_with(pool)), base_url="http://t") as c:
            responses = await asyncio.gather(*(c.get("/healthz") for _ in range(10)))
        return [r.status_code for r in responses]

    assert asyncio.run(run()) == [503] * 10
    assert pool.max_open == 1
    assert pool.open_now == 0, "the timed-out probe must give its connection back"
