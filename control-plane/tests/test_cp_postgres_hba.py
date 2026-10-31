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


def test_cp_postgres_uses_the_repository_hba_file() -> None:
    compose = (DEPLOY / "compose.controlplane.yaml").read_text()
    block = re.search(r"^  cp_postgres:\n(.*?)\n\n", compose, re.S | re.M)
    assert block, "no cp_postgres service"
    assert "hba_file=/etc/postgresql/mergit/pg_hba.conf" in block.group(1)
    assert '"./postgres:/etc/postgresql/mergit:ro"' in block.group(1)


def test_only_the_worker_role_may_log_in_from_outside_the_compose_network() -> None:
    remote = [
        r for r in _rules() if r[0].startswith("host") and r[3] not in ("127.0.0.1/32", "::1/128", "samenet")
    ]
    assert remote == [["host", "mergit_cp", "mergit_worker", "all", "scram-sha-256"]]


def test_no_rule_trusts_a_network_address() -> None:
    trusted = [r for r in _rules() if r[0].startswith("host") and r[-1] == "trust"]
    assert all(r[3] in ("127.0.0.1/32", "::1/128") for r in trusted)
