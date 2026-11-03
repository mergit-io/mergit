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
