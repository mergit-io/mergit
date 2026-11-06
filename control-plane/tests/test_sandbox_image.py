"""The worker refuses to start without its sandbox image, rather than failing every job it would claim."""

from __future__ import annotations

from typing import Any, cast

import docker
import docker.errors
import pytest

from mergit_worker.sandbox import SandboxError, require_image


class _Images:
    def __init__(self, present: set[str]) -> None:
        self._present = present

    def get(self, name: str) -> object:
        if name not in self._present:
            raise docker.errors.ImageNotFound(name)
        return object()


def _client(*present: str) -> docker.DockerClient:
    fake: Any = type("FakeDocker", (), {})()
    fake.images = _Images(set(present))
    return cast(docker.DockerClient, fake)


def test_a_missing_image_says_how_to_build_it() -> None:
    with pytest.raises(SandboxError, match=r"docker build -t mergit-sandbox:dev control-plane/sandbox"):
        require_image("mergit-sandbox:dev", _client())


def test_a_built_image_passes() -> None:
    require_image("mergit-sandbox:dev", _client("mergit-sandbox:dev"))
