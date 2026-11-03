"""The deploy shell scripts, run with stub `docker`, `curl`, `git` and `sleep` on PATH (no Docker or network).

Postgres-backed behaviour of create-db-role.sh is in tests/test_worker_role.py.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"
SCRIPTS = (
    "server/update.sh",
    "worker-vm/preflight.sh",
    "worker-vm/create-db-role.sh",
    "make-controlplane-env.sh",
)

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")


def _stub(bin_dir: Path, name: str, body: str) -> None:
    path = bin_dir / name
    path.write_text("#!/usr/bin/env bash\n" + body + "\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _run(cmd: list[str], bin_dir: Path, cwd: Path, **env: str) -> subprocess.CompletedProcess[str]:
    base = {"PATH": f"{bin_dir}:{os.environ['PATH']}", "HOME": str(cwd)}
    return subprocess.run(cmd, env={**base, **env}, cwd=cwd, capture_output=True, text=True, check=False)


@pytest.mark.parametrize("script", SCRIPTS)
def test_the_script_parses(script: str) -> None:
    run = subprocess.run(["bash", "-n", str(DEPLOY / script)], capture_output=True, text=True, check=False)
    assert run.returncode == 0, run.stderr


# -- update.sh -------------------------------------------------------------------------------------------


def _update_tree(
    tmp_path: Path, *, api_up: bool, public_up: bool, not_running: tuple[str, ...] = ()
) -> tuple[Path, Path]:
    root = tmp_path / "mergit"
    (root / "deploy" / "server").mkdir(parents=True)
    shutil.copy(DEPLOY / "server" / "update.sh", root / "deploy" / "server")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _stub(bin_dir, "git", "exit 0")
    _stub(bin_dir, "sleep", "exit 0")
    _stub(bin_dir, "curl", "exit 0" if public_up else "exit 6")
    # `exec -T api` is the check over the compose network; `ps --status running --services` lists what runs.
    running = [s for s in ("gateway", "store", "api", "caddy") if s not in not_running]
    _stub(
        bin_dir,
        "docker",
        'case " $* " in\n'
        f'  *" exec -T api "*) exit {0 if api_up else 1} ;;\n'
        f'  *" --services "*) printf "%s\\n" {" ".join(running)}; exit 0 ;;\n'
        "esac; exit 0",
    )
    return root, bin_dir


def test_update_succeeds_with_a_warning_when_the_public_urls_are_not_reachable_yet(tmp_path: Path) -> None:
    root, bin_dir = _update_tree(tmp_path, api_up=True, public_up=False)
    run = _run(["bash", str(root / "deploy/server/update.sh"), "services"], bin_dir, root)
    assert run.returncode == 0, run.stderr
    assert "warning" in run.stderr and "api.mergit.site" in run.stderr
    assert "api (compose network): ok" in run.stdout


def test_update_fails_when_the_api_never_answers_over_the_compose_network(tmp_path: Path) -> None:
    root, bin_dir = _update_tree(tmp_path, api_up=False, public_up=True)
    run = _run(["bash", str(root / "deploy/server/update.sh"), "services"], bin_dir, root)
    assert run.returncode != 0
    assert "api container did not answer" in run.stderr


@pytest.mark.parametrize("service", ["gateway", "store"])
def test_update_fails_when_the_gateway_or_store_container_is_not_running(
    tmp_path: Path, service: str
) -> None:
    root, bin_dir = _update_tree(tmp_path, api_up=True, public_up=True, not_running=(service,))
    run = _run(["bash", str(root / "deploy/server/update.sh"), "services"], bin_dir, root)
    assert run.returncode != 0
    assert f"the {service} container is not running" in run.stderr


def test_update_is_not_fooled_by_a_long_service_list_that_sigpipes_grep(tmp_path: Path) -> None:
    """`ps --services | grep -q` would quit at `gateway` while ps still writes: SIGPIPE, exit 141, a healthy
    service reported as not running. The stub writes far more than a pipe buffer holds after the names."""
    root, bin_dir = _update_tree(tmp_path, api_up=True, public_up=True)
    _stub(
        bin_dir,
        "docker",
        'case " $* " in\n'
        '  *" exec -T api "*) exit 0 ;;\n'
        '  *" --services "*) echo gateway; echo store; exec seq 1 300000 ;;\n'
        "esac; exit 0",
    )
    run = _run(["bash", str(root / "deploy/server/update.sh"), "services"], bin_dir, root)
    assert run.returncode == 0, run.stderr


def test_update_fails_loudly_when_compose_ps_itself_fails(tmp_path: Path) -> None:
    root, bin_dir = _update_tree(tmp_path, api_up=True, public_up=True)
    _stub(
        bin_dir,
        "docker",
        'case " $* " in\n  *" exec -T api "*) exit 0 ;;\n  *" --services "*) exit 1 ;;\nesac; exit 0',
    )
    run = _run(["bash", str(root / "deploy/server/update.sh"), "services"], bin_dir, root)
    assert run.returncode != 0 and "container is not running" in run.stderr


def test_update_fails_when_the_build_fails(tmp_path: Path) -> None:
    root, bin_dir = _update_tree(tmp_path, api_up=True, public_up=True)
    _stub(bin_dir, "docker", 'case " $* " in *" up -d "*) exit 1 ;; esac; exit 0')
    run = _run(["bash", str(root / "deploy/server/update.sh"), "services"], bin_dir, root)
    assert run.returncode != 0


# -- preflight.sh ----------------------------------------------------------------------------------------


def _preflight_tree(tmp_path: Path, worker_env: str) -> tuple[Path, Path, Path]:
    vm = tmp_path / "mergit" / "deploy" / "worker-vm"
    vm.mkdir(parents=True)
    shutil.copy(DEPLOY / "worker-vm" / "preflight.sh", vm)
    (vm / "worker.env").write_text(worker_env)
    (vm / "worker.env").chmod(0o600)
    workspaces = tmp_path / "workspaces"
    workspaces.mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    seen = tmp_path / "docker-run-env"
    _stub(bin_dir, "python3", "exit 1")  # the agent-key check is not under test
    _stub(bin_dir, "curl", "exit 0")
    # `docker run` records the DATABASE_URL it was given through the environment, and every arg.
    _stub(
        bin_dir,
        "docker",
        f'case "$1" in run) printf "%s" "$DATABASE_URL" > {seen}; '
        f'printf "%s\\n" "$@" > {seen}.args ;; esac; exit 0',
    )
    return vm, bin_dir, workspaces


ENV_QUOTED = """WORKER_ID="vm-1"
DATABASE_URL='postgres://mergit_worker:pw@10.0.0.2:5433/mergit_cp?sslmode=prefer'
EVENTS_TOKEN="e"
STORE_WRITE_TOKEN='s'
WORKER_TOKEN="w"
ANTHROPIC_API_KEY="k"
"""


def test_preflight_strips_quotes_like_compose_and_passes_the_clean_url_to_the_database_check(
    tmp_path: Path,
) -> None:
    vm, bin_dir, workspaces = _preflight_tree(tmp_path, ENV_QUOTED)
    run = _run(["bash", str(vm / "preflight.sh")], bin_dir, vm, WORKSPACES=str(workspaces))
    out = run.stdout + run.stderr
    assert "DATABASE_URL points at this machine" not in out
    assert "WORKER_ID is empty" not in out and "ok:   WORKER_ID is set" in out
    seen = tmp_path / "docker-run-env"
    assert seen.read_text() == "postgres://mergit_worker:pw@10.0.0.2:5433/mergit_cp?sslmode=prefer"
    args = (tmp_path / "docker-run-env.args").read_text()
    assert "--env-file" not in args  # the env file would keep the quote characters
    assert "pw@" not in args  # the URL is never on a command line
    assert "ok:   the database accepts this worker's credentials" in out


# -- create-db-role.sh -----------------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["postgres", "pg_monitor", "pg_write_all_data"])
def test_create_db_role_refuses_the_superuser_and_builtin_names_before_running_anything(
    tmp_path: Path, name: str
) -> None:
    marker = tmp_path / "psql-was-run"
    env = {
        "PATH": os.environ["PATH"],
        "PSQL": f"touch {marker}",
        "WORKER_DB_ROLE": name,
        "WORKER_DB_PASSWORD": "a-long-enough-password-0123456789",
    }
    run = subprocess.run(
        ["bash", str(DEPLOY / "worker-vm/create-db-role.sh")],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert run.returncode != 0
    assert "refused" in run.stderr
    assert not marker.exists() and run.stdout == ""
