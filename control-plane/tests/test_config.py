"""Defaults and overrides for `Settings` fields that are plain typed config, not a deployment fact."""

from pathlib import Path

import pytest

from mergit_cp.config import Settings
from tests.test_account_settings import REQUIRED


def _settings(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **extra: str) -> Settings:
    monkeypatch.chdir(tmp_path)  # no stray .env
    for key, value in (REQUIRED | extra).items():
        monkeypatch.setenv(key, value)
    return Settings()  # pyright: ignore[reportCallIssue]


def test_reputation_and_router_defaults(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    s = _settings(monkeypatch, tmp_path)
    assert s.reputation_pooling_weight == 0.25
    assert s.reputation_value_ref_usdc_units == 1_000_000
    assert s.router_prior_cost_micros == 200_000


def test_reputation_and_router_overrides_from_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    s = _settings(
        monkeypatch,
        tmp_path,
        REPUTATION_POOLING_WEIGHT="0.5",
        REPUTATION_VALUE_REF_USDC_UNITS="2000000",
        ROUTER_PRIOR_COST_MICROS="300000",
    )
    assert s.reputation_pooling_weight == 0.5
    assert s.reputation_value_ref_usdc_units == 2_000_000
    assert s.router_prior_cost_micros == 300_000
