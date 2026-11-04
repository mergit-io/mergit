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
    """A pool whose probe takes a moment and counts how often it was asked, failing when ``fail`` is set."""

    def __init__(self, fail: bool = False) -> None:
        self.calls = 0
        self.fail = fail

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[Any]:
        pool = self

        class Conn:
            async def execute(self, _sql: str) -> None:
                pool.calls += 1
                await asyncio.sleep(0.05)
                if pool.fail:
                    raise OSError("connection refused")

        yield Conn()


def _burst(app: FastAPI, n: int) -> list[int]:
    import httpx

    async def go() -> list[int]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            responses = await asyncio.gather(*(c.get("/healthz") for _ in range(n)))
        return [r.status_code for r in responses]

    return asyncio.run(go())


def test_a_flood_of_healthz_requests_costs_one_database_probe() -> None:
    """/healthz is public: without the cache, every request took a pool connection for a SELECT 1, and a flood
    could exhaust the pool the real routes need."""
    pool = _CountingPool()
    assert _burst(_app_with(pool), 25) == [200] * 25
    assert pool.calls == 1


def test_the_cached_answer_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(health, "HEALTH_CACHE_S", 0.0)
    pool = _CountingPool()
    app = _app_with(pool)
    with TestClient(app) as c:
        for _ in range(3):
            assert c.get("/healthz").status_code == 200
    assert pool.calls == 3


def test_a_failing_database_is_not_hammered_and_logs_no_traceback(caplog: pytest.LogCaptureFixture) -> None:
    pool = _CountingPool(fail=True)
    with caplog.at_level("WARNING", logger="mergit_cp.health"):
        assert _burst(_app_with(pool), 25) == [503] * 25
    assert pool.calls == 1
    records = [r for r in caplog.records if r.name == "mergit_cp.health"]
    assert len(records) == 1 and records[0].exc_info is None
    assert "OSError" in records[0].getMessage() and "refused" not in records[0].getMessage()
