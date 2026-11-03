"""cp_postgres must not let the superuser in from outside the compose network (deploy/postgres/pg_hba.conf).

CP_DB_BIND publishes the port on the private network for the worker VM. With the image's default rules the
superuser would log in from there too, with the password in compose.controlplane.yaml.
"""

import re
from pathlib import Path

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"


def _rules() -> list[list[str]]:
    text = (DEPLOY / "postgres" / "pg_hba.conf").read_text()
    return [line.split() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def _compose_subnet() -> str:
    """The CIDR pinned in compose.controlplane.yaml's `networks.default.ipam`, which pg_hba.conf must match
    exactly: a looser or different rule there would silently stop matching this file's `all all` line."""
    compose = (DEPLOY / "compose.controlplane.yaml").read_text()
    match = re.search(r"subnet:\s*(\S+)\s*}", compose)
    assert match, "no pinned subnet in compose.controlplane.yaml's networks.default.ipam"
    return match.group(1)


def test_cp_postgres_uses_the_repository_hba_file() -> None:
    compose = (DEPLOY / "compose.controlplane.yaml").read_text()
    block = re.search(r"^  cp_postgres:\n(.*?)\n\n", compose, re.S | re.M)
    assert block, "no cp_postgres service"
    assert "hba_file=/etc/postgresql/mergit/pg_hba.conf" in block.group(1)
    assert '"./postgres:/etc/postgresql/mergit:ro"' in block.group(1)


def test_the_compose_network_is_pinned_not_left_to_docker_to_pick() -> None:
    # `samenet` in pg_hba.conf would match whatever subnet Docker assigns, including a bridge gateway address
    # a published port can see as its source under some Docker network settings. A fixed CIDR cannot.
    subnet = _compose_subnet()
    assert re.fullmatch(r"\d+\.\d+\.\d+\.\d+/\d+", subnet), subnet


def test_only_the_worker_role_may_log_in_from_outside_the_compose_network() -> None:
    compose_subnet = _compose_subnet()
    remote = [
        r
        for r in _rules()
        if r[0].startswith("host") and r[3] not in ("127.0.0.1/32", "::1/128", "samenet", compose_subnet)
    ]
    assert remote == [["host", "mergit_cp", "mergit_worker", "all", "scram-sha-256"]]


def test_the_compose_network_rule_uses_the_pinned_subnet_not_samenet() -> None:
    compose_subnet = _compose_subnet()
    broad = [r for r in _rules() if r[0:3] == ["host", "all", "all"] and r[-1] == "scram-sha-256"]
    assert broad == [["host", "all", "all", compose_subnet, "scram-sha-256"]]


def test_no_rule_trusts_a_network_address() -> None:
    trusted = [r for r in _rules() if r[0].startswith("host") and r[-1] == "trust"]
    assert all(r[3] in ("127.0.0.1/32", "::1/128") for r in trusted)


def test_the_api_port_is_not_published_to_every_interface() -> None:
    # On the server, compose.server.yaml resets this to nothing and Caddy reaches `api` by name. Published to
    # 0.0.0.0 here, a run without compose.server.yaml would expose the unproxied API to the internet.
    compose = (DEPLOY / "compose.controlplane.yaml").read_text()
    block = re.search(r"^  api:\n(.*?)\n\n", compose, re.S | re.M)
    assert block, "no api service"
    assert re.search(r'ports:\s*\["127\.0\.0\.1:8000:8000"\]', block.group(1))
