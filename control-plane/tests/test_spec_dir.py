"""The control plane validates every plan check and every event against spec/schemas, so the schemas must be
where it looks. They were missing from the API image, which made every plan draft a 500: this keeps that from
returning."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from mergit_cp import spec

ROOT = Path(__file__).resolve().parents[2]


def test_the_repository_schemas_satisfy_the_start_up_check() -> None:
    spec.require_schemas(ROOT / "spec")


def test_an_empty_or_missing_schema_directory_stops_start_up_with_a_clear_message(tmp_path: Path) -> None:
    for where in (tmp_path, tmp_path / "does-not-exist"):
        with pytest.raises(spec.EventSchemaError, match=r"predicate.*MERGIT_SPEC_DIR"):
            spec.require_schemas(where)


def test_a_directory_with_only_some_schemas_is_refused(tmp_path: Path) -> None:
    (tmp_path / "schemas").mkdir()
    src = (ROOT / "spec" / "schemas").glob("*.json")
    for p in src:
        if p.name != "predicate.json":
            (tmp_path / "schemas" / p.name).write_text(p.read_text())
    with pytest.raises(spec.EventSchemaError, match="predicate"):
        spec.require_schemas(tmp_path)


def test_the_api_image_ships_the_schemas_and_points_at_them() -> None:
    dockerfile = (ROOT / "control-plane" / "Dockerfile").read_text()
    final_stage = dockerfile.split("FROM python:3.13-slim\n", 1)[1]
    assert re.search(r"^COPY spec/schemas\s+spec/schemas\s*$", final_stage, re.M), (
        "the schemas are not copied"
    )
    assert re.search(r"^ENV MERGIT_SPEC_DIR=/app/spec\s*$", final_stage, re.M), "MERGIT_SPEC_DIR is not set"
