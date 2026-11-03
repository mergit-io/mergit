"""cp_postgres must not let the superuser in from outside the compose network (deploy/postgres/pg_hba.conf).

CP_DB_BIND publishes the port on the private network for the worker VM. With the image's default rules the
superuser would log in from there too. A rule naming the compose network has to leave out the bridge
gateway's address: behind Docker's userland proxy (and with rootless Docker or iptables off) a connection to a
published port reaches the container FROM the gateway, so `samenet`, which includes it, would let the worker
VM in as `postgres`.
"""

from __future__ import annotations

import ipaddress
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"
LOOPBACK = ("127.0.0.1/32", "::1/128")
# Addresses pg_hba.conf accepts that are not a CIDR: each one would include the bridge gateway or anything.
KEYWORDS = ("all", "samehost", "samenet")


def _rules() -> list[list[str]]:
    text = (DEPLOY / "postgres" / "pg_hba.conf").read_text()
    return [line.split() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def _compose() -> str:
    """compose.controlplane.yaml without its comments (they may name what the settings must not)."""
    text = (DEPLOY / "compose.controlplane.yaml").read_text()
    lines = (re.sub(r"(^|\s)#.*$", "", line) for line in text.splitlines())
    return "\n".join(line for line in lines if line.strip() or not line)


def _network() -> dict[str, str]:
    """The compose network's fixed addresses (top-level `networks:`), the one place the subnet is defined."""
    block = re.search(r"^networks:\n(.*?)(?=^\S|\Z)", _compose(), re.S | re.M)
    assert block, "compose.controlplane.yaml defines no network"
    plan = dict(re.findall(r"\b(subnet|ip_range|gateway): *([0-9a-f.:/]+)", block.group(1)))
    assert set(plan) == {"subnet", "ip_range", "gateway"}, plan
    return plan


def _admits_superuser(users: str) -> bool:
    # `all`, the name itself, a group (+role) or a file of names (@file) may each include postgres.
    return any(u in ("all", "postgres") or u[:1] in "+@" for u in users.split(","))


def test_cp_postgres_uses_the_repository_hba_file() -> None:
    compose = (DEPLOY / "compose.controlplane.yaml").read_text()
    block = re.search(r"^  cp_postgres:\n(.*?)\n\n", compose, re.S | re.M)
    assert block, "no cp_postgres service"
    assert "hba_file=/etc/postgresql/mergit/pg_hba.conf" in block.group(1)
    assert '"./postgres:/etc/postgresql/mergit:ro"' in block.group(1)


def test_the_database_port_is_published_on_loopback_unless_cp_db_bind_says_otherwise() -> None:
    """An unset CP_DB_BIND must never publish Postgres on every interface (Docker skips the host
    firewall), and the API's own port must stay on loopback too, so the Caddy lockdown cannot be bypassed."""
    compose = _compose()
    assert '"${CP_DB_BIND:-127.0.0.1}:5433:5432"' in compose
    assert '"127.0.0.1:8000:8000"' in compose
    assert not re.search(r'"(0\.0\.0\.0:)?8000:8000"', compose)


def test_the_compose_network_keeps_the_gateway_out_of_the_container_range() -> None:
    net = _network()
    subnet = ipaddress.ip_network(net["subnet"])
    containers = ipaddress.ip_network(net["ip_range"])
    gateway = ipaddress.ip_address(net["gateway"])
    assert containers.subnet_of(subnet)  # pyright: ignore[reportArgumentType]
    assert gateway in subnet
    assert gateway not in containers


def test_no_rule_admits_the_postgres_superuser_from_a_subnet_the_bridge_gateway_is_in() -> None:
    net = _network()
    gateway = ipaddress.ip_address(net["gateway"])
    superuser = [r for r in _rules() if r[0].startswith("host") and _admits_superuser(r[2])]
    addresses = [r[3] for r in superuser]
    for address in addresses:
        assert address not in KEYWORDS, f"{address} includes the bridge gateway"
        assert "/" in address, f"{address}: a host name or a separate netmask column; use a CIDR"
        assert gateway not in ipaddress.ip_network(address), f"{address} includes the gateway {gateway}"
    # Loopback inside the container, and the compose network's container range from compose.controlplane.yaml.
    assert sorted(addresses) == sorted([*LOOPBACK, net["ip_range"]])


def test_only_the_worker_role_may_log_in_from_outside_the_compose_network() -> None:
    inside = (*LOOPBACK, _network()["ip_range"])
    remote = [r for r in _rules() if r[0].startswith("host") and r[3] not in inside]
    assert remote == [["host", "mergit_cp", "mergit_worker", "all", "scram-sha-256"]]


def test_no_rule_trusts_a_network_address() -> None:
    trusted = [r for r in _rules() if r[0].startswith("host") and r[-1] == "trust"]
    assert all(r[3] in LOOPBACK for r in trusted)


def test_compose_has_no_literal_superuser_password() -> None:
    """The password comes from secrets/cp_postgres.env, api.env and worker.env (make-controlplane-env.sh)."""
    text = _compose()
    assert not re.search(r"postgres(ql)?://[^\s/:@]+:[^\s@]+@", text), "a database URL with a password in it"
    # Set in compose, either would override the generated value from the service's env_file.
    assert "POSTGRES_PASSWORD" not in text
    assert "DATABASE_URL" not in text
    block = re.search(r"^  cp_postgres:\n(.*?)\n\n", text, re.S | re.M)
    assert block, "no cp_postgres service"
    assert re.search(r"^    env_file: secrets/cp_postgres\.env$", block.group(1), re.M)


# -- make-controlplane-env.sh generates the password ---------------------------------------------------------


def _env(path: Path) -> dict[str, str]:
    lines = [line for line in path.read_text().splitlines() if line and not line.startswith("#")]
    return dict(line.split("=", 1) for line in lines)


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
def test_the_env_script_gives_postgres_the_api_and_the_worker_one_generated_password(tmp_path: Path) -> None:
    # The script's layout: deploy/secrets/testnet.env, and ../../mergit-contracts/.env.services next to it.
    deploy = tmp_path / "mergit" / "deploy"
    (deploy / "secrets").mkdir(parents=True)
    shutil.copy(DEPLOY / "make-controlplane-env.sh", deploy)
    tokens = ("EVENTS_TOKEN", "CHAIN_EVENTS_TOKEN", "WORKER_TOKEN", "STORE_WRITE_TOKEN")
    (deploy / "secrets" / "testnet.env").write_text("".join(f"{t}=test-{t.lower()}\n" for t in tokens))
    (tmp_path / "mergit-contracts").mkdir()
    (tmp_path / "mergit-contracts" / ".env.services").write_text("MERGIT_AGENT_KEY_1=0x" + "1" * 64 + "\n")
    env = {"PATH": os.environ["PATH"], "ANTHROPIC_API_KEY": "test-anthropic-key"}

    run = subprocess.run(
        ["bash", str(deploy / "make-controlplane-env.sh"), "localhost:5173"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
        input="\n",  # Enter at the GROQ_API_KEY prompt: skip it
    )
    assert run.returncode == 0, run.stderr

    secrets = deploy / "secrets"
    password = _env(secrets / "cp_postgres.env")["POSTGRES_PASSWORD"]
    assert re.fullmatch(r"[0-9a-f]{48}", password)
    url = f"postgres://postgres:{password}@cp_postgres:5432/mergit_cp"
    assert _env(secrets / "api.env")["DATABASE_URL"] == url
    assert _env(secrets / "worker.env")["DATABASE_URL"] == url
    assert password not in run.stdout + run.stderr  # names only, never values
    for name in ("cp_postgres.env", "api.env", "worker.env"):
        assert stat.S_IMODE((secrets / name).stat().st_mode) == 0o600, name


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
def test_the_env_script_refusal_warns_that_regenerating_locks_out_an_existing_database(
    tmp_path: Path,
) -> None:
    deploy = tmp_path / "mergit" / "deploy"
    (deploy / "secrets").mkdir(parents=True)
    shutil.copy(DEPLOY / "make-controlplane-env.sh", deploy)
    (deploy / "secrets" / "testnet.env").write_text("")
    (tmp_path / "mergit-contracts").mkdir()
    (tmp_path / "mergit-contracts" / ".env.services").write_text("")
    (deploy / "secrets" / "api.env").write_text("X=1\n")
    run = subprocess.run(
        ["bash", str(deploy / "make-controlplane-env.sh")],
        env={"PATH": os.environ["PATH"]},
        capture_output=True,
        text=True,
        check=False,
    )
    assert run.returncode != 0
    assert "cp_pgdata" in run.stderr and "locked out" in run.stderr
    assert "deploy/server/README.md" in run.stderr
