"""World ID is off unless every value one half needs is set (plan sec 1.4/1.7), and the migration that
creates its tables lands the schema plan sec 1.4 specifies exactly."""

from __future__ import annotations

import psycopg
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from mergit_cp.config import Settings

SETTINGS = Settings(
    database_url="unused",
    app_domain="app.mergit.test",
    session_secret=SecretStr("test-secret-at-least-32-bytes-long!!"),
    gateway_url="http://gateway.invalid",
    store_url="http://store.invalid",
    agents_file="unused",
    planner_model="claude-opus-5",
    planner_provider="anthropic",
    events_token=SecretStr("test-events-token"),
    chain_events_token=SecretStr("test-chain-events-token"),
    worker_token=SecretStr("test-worker-token"),
)


def test_world_is_off_unless_every_value_is_set() -> None:
    assert not SETTINGS.world_idkit_enabled and not SETTINGS.world_idp_enabled
    on = SETTINGS.model_copy(
        update={
            "world_app_id": "app_x",
            "world_rp_id": "rp_x",
            "world_signing_key": SecretStr("11" * 32),
        }
    )
    assert on.world_idkit_enabled and not on.world_idp_enabled


def test_world_idp_needs_both_client_id_and_secret() -> None:
    assert not SETTINGS.world_idp_enabled
    half = SETTINGS.model_copy(update={"world_idp_client_id": "client_x"})
    assert not half.world_idp_enabled
    both = SETTINGS.model_copy(
        update={"world_idp_client_id": "client_x", "world_idp_client_secret": SecretStr("secret_x")}
    )
    assert both.world_idp_enabled


def test_blank_world_env_values_are_treated_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    # Same behaviour as `_blank_is_unset` for the existing optional methods (config.py): a deploy file that
    # carries `WORLD_APP_ID=` for a half that is not set up yet must not crash or count as configured.
    monkeypatch.setenv("DATABASE_URL", "unused")
    monkeypatch.setenv("APP_DOMAIN", "app.mergit.test")
    monkeypatch.setenv("SESSION_SECRET", "test-secret-at-least-32-bytes-long!!")
    monkeypatch.setenv("GATEWAY_URL", "http://gateway.invalid")
    monkeypatch.setenv("STORE_URL", "http://store.invalid")
    monkeypatch.setenv("AGENTS_FILE", "unused")
    monkeypatch.setenv("PLANNER_MODEL", "claude-opus-5")
    monkeypatch.setenv("PLANNER_PROVIDER", "anthropic")
    monkeypatch.setenv("EVENTS_TOKEN", "test-events-token")
    monkeypatch.setenv("CHAIN_EVENTS_TOKEN", "test-chain-events-token")
    monkeypatch.setenv("WORKER_TOKEN", "test-worker-token")
    monkeypatch.setenv("WORLD_APP_ID", "")
    monkeypatch.setenv("WORLD_RP_ID", "")
    monkeypatch.setenv("WORLD_ENVIRONMENT", "")
    s = Settings()  # pyright: ignore[reportCallIssue]
    assert s.world_app_id is None
    assert s.world_rp_id is None
    assert s.world_environment == "production"
    assert not s.world_idkit_enabled


@pytest.mark.postgres
def test_migration_creates_the_world_tables(client: TestClient, database_url: str) -> None:
    with psycopg.connect(database_url) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT table_name FROM information_schema.tables"
                " WHERE table_schema = 'public' AND table_name LIKE 'world_%'"
            ).fetchall()
        }
        assert tables == {"world_nullifiers", "world_links", "world_approvals"}

        pk_cols = conn.execute(
            """
            SELECT a.attname
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = 'world_nullifiers'::regclass AND i.indisprimary
            ORDER BY array_position(i.indkey, a.attnum)
            """
        ).fetchall()
        assert [c[0] for c in pk_cols] == ["action", "nullifier"]

        def is_unique(table: str, column: str) -> bool:
            rows = conn.execute(
                """
                SELECT a.attname
                FROM pg_index i
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                WHERE i.indrelid = %s::regclass AND i.indisunique AND array_length(i.indkey, 1) = 1
                """,
                (table,),
            ).fetchall()
            return column in {r[0] for r in rows}

        assert is_unique("world_links", "sub")
        assert is_unique("world_approvals", "jti")
        assert is_unique("world_approvals", "state")
