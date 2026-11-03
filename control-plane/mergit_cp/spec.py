"""The JSON Schemas in spec/schemas, loaded once. They are the contract with the Rust services, so the
control plane checks what it sends against the same files the gateway checks what it receives."""

import json
import os
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, ValidationError
from referencing import Registry, Resource

_DEFAULT_SPEC_DIR = Path(__file__).resolve().parents[2] / "spec"


class EventSchemaError(ValueError):
    """An event this service built does not match spec/schemas/event.json. A bug here, never sent."""


def spec_dir() -> Path:
    return Path(os.environ.get("MERGIT_SPEC_DIR", _DEFAULT_SPEC_DIR))


@cache
def _validators(directory: Path) -> dict[str, Draft202012Validator]:
    schemas = [json.loads(p.read_text()) for p in sorted((directory / "schemas").glob("*.json"))]
    resources: list[tuple[str, Resource[Any]]] = [(s["$id"], Resource.from_contents(s)) for s in schemas]
    registry: Registry[Any] = Registry[Any]().with_resources(resources)
    return {
        s["$id"].rsplit("/", 1)[-1].removesuffix(".json"): Draft202012Validator(s, registry=registry)
        for s in schemas
    }


REQUIRED_SCHEMAS = ("event", "predicate")


def require_schemas(directory: Path | None = None) -> None:
    """Refuses to start without the schemas this service validates against. Otherwise a missing directory
    shows up later as a KeyError inside a request (every plan draft was a 500 on the server when the API
    image lacked them), which is a much harder thing to find."""
    where = directory or spec_dir()
    found = _validators(where) if (where / "schemas").is_dir() else {}
    missing = [name for name in REQUIRED_SCHEMAS if name not in found]
    if missing:
        raise EventSchemaError(
            f"no schema for {', '.join(missing)} under {where}/schemas; set MERGIT_SPEC_DIR to the directory "
            "that holds the repository's spec/schemas"
        )


def schema_errors(name: str, instance: Any) -> list[str]:
    """Readable problems with ``instance`` against ``spec/schemas/<name>.json``; empty when valid."""
    validator = _validators(spec_dir())[name]
    errors: list[ValidationError] = list(validator.iter_errors(instance))  # pyright: ignore[reportUnknownMemberType]
    return [
        f"{'/'.join(str(p) for p in e.absolute_path) or name}: {e.message}"
        for e in sorted(errors, key=lambda e: [str(p) for p in e.absolute_path])
    ]


def validate_event(envelope: dict[str, Any]) -> None:
    problems = schema_errors("event", envelope)
    if problems:
        raise EventSchemaError("; ".join(problems))
