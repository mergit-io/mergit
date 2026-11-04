"""Blank sign-in settings in api.env mean "not set up", not a crash at start."""

from pathlib import Path

import pytest

from mergit_cp.config import Settings

REQUIRED = {
    "DATABASE_URL": "postgresql://x",
    "APP_DOMAIN": "app.mergit.test",
    "SESSION_SECRET": "s" * 32,
    "GATEWAY_URL": "http://g",
    "STORE_URL": "http://s",
    "AGENTS_FILE": "a.json",
    "PLANNER_MODEL": "m",
    "PLANNER_PROVIDER": "anthropic",
    "EVENTS_TOKEN": "e",
    "CHAIN_EVENTS_TOKEN": "c",
    "WORKER_TOKEN": "w",
}


def _settings(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **extra: str) -> Settings:
    monkeypatch.chdir(tmp_path)  # no stray .env
    for key, value in (REQUIRED | extra).items():
        monkeypatch.setenv(key, value)
    return Settings()  # pyright: ignore[reportCallIssue]


def test_blank_values_leave_every_method_off(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    blanks = dict.fromkeys(
        [
            "GITHUB_CLIENT_ID",
            "GITHUB_CLIENT_SECRET",
            "GOOGLE_CLIENT_ID",
            "GOOGLE_CLIENT_SECRET",
            "SMTP_HOST",
            "SMTP_PORT",
            "SMTP_USER",
            "SMTP_PASSWORD",
            "SMTP_FROM",
        ],
        "",
    )
    s = _settings(monkeypatch, tmp_path, **blanks)
    assert (s.github_enabled, s.google_enabled, s.email_enabled) == (False, False, False)
    assert s.smtp_port == 587


def test_a_method_needs_both_halves(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    s = _settings(
        monkeypatch, tmp_path, GITHUB_CLIENT_ID="id", GOOGLE_CLIENT_ID="id", GOOGLE_CLIENT_SECRET="x"
    )
    assert (s.github_enabled, s.google_enabled) == (False, True)


def test_public_origin_is_https_except_on_localhost(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    assert _settings(monkeypatch, tmp_path).public_origin == "https://app.mergit.test"
    assert (
        _settings(monkeypatch, tmp_path, APP_DOMAIN="localhost:5173").public_origin == "http://localhost:5173"
    )
