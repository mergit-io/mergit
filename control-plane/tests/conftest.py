from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from testcontainers.community.postgres import PostgresContainer

from mergit_cp.app import create_app
from mergit_cp.config import Settings
from tests.support import ProcessSandbox, RecordingPublisher, make_repo


@pytest.fixture
def repo_url(tmp_path: Path) -> str:
    return make_repo(tmp_path)


@pytest.fixture
def sandbox(repo_url: str, tmp_path: Path) -> Iterator[ProcessSandbox]:
    sbx = ProcessSandbox.create(repo_url, "main", tmp_path / "ws")
    yield sbx
    sbx.destroy()


@pytest.fixture
def publisher() -> RecordingPublisher:
    return RecordingPublisher(sealed=[])


# Control-plane API fixtures. Tests that use `client` or `database_url` must be marked `postgres`.
APP_DOMAIN = "app.mergit.test"


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    with PostgresContainer("postgres:16", driver=None) as pg:
        yield pg.get_connection_url()


@pytest.fixture
def agents_files(tmp_path: Path) -> tuple[Path, Path]:
    chain = tmp_path / "agents.json"
    chain.write_text(
        '{"agents": [{"agent_id": "1", "name": "coder-a",'
        ' "operator": "0x1111111111111111111111111111111111111111",'
        ' "runtime_key": "0x2222222222222222222222222222222222222222",'
        ' "metadata_uri": "ipfs://example"}]}'
    )
    config = tmp_path / "agents.toml"
    config.write_text(
        '[providers.anthropic]\nkind = "anthropic"\n\n'
        '[agents.coder-a]\nprovider = "anthropic"\nmodel = "claude-sonnet-5"\n'
        'system_prompt = "You fix failing tests."\n'
    )
    return chain, config


@pytest.fixture
def settings(database_url: str, agents_files: tuple[Path, Path]) -> Settings:
    chain, config = agents_files
    return Settings(
        database_url=database_url,
        app_domain=APP_DOMAIN,
        session_secret=SecretStr("test-secret-at-least-32-bytes-long!!"),
        gateway_url="http://gateway.invalid",
        store_url="http://store.invalid",
        agents_file=str(chain),
        agents_config=str(config),
        cors_origins=["http://localhost:5173"],
        planner_model="claude-opus-5",
        events_token=SecretStr("test-events-token"),
        chain_events_token=SecretStr("test-chain-events-token"),
        worker_token=SecretStr("test-worker-token"),
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    # https so the Secure session cookie is sent back on later requests.
    with TestClient(create_app(settings), base_url="https://testserver") as c:
        yield c
    with psycopg.connect(settings.database_url) as conn:
        tables = conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'"
        ).fetchall()
        if tables:
            conn.execute("TRUNCATE " + ", ".join(t[0] for t in tables))
