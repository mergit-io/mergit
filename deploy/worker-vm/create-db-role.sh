#!/usr/bin/env bash
# Creates the worker VM's database role (mergit_worker) with only the rights in db-role.sql, or resets its password.
#   deploy/worker-vm/create-db-role.sh                          # makes a password and prints it once
#   WORKER_DB_PASSWORD=... deploy/worker-vm/create-db-role.sh   # uses one you chose (A-Z a-z 0-9 . _ ~ -, 24+ long)
#   WORKER_DB_ROLE=... deploy/worker-vm/create-db-role.sh       # another role name (default mergit_worker). Only
#                                                               # mergit_worker may log in through pg_hba.conf.
# Run it on the server that runs cp_postgres, after the control plane has started once (it creates the tables).
# Safe to run again: it re-sets the password and takes back any right that is not in db-role.sql.
# PSQL replaces how psql is reached, for testing this script against a throwaway database.
set -euo pipefail
cd "$(dirname "$0")/../.."

role=${WORKER_DB_ROLE:-mergit_worker}
[[ $role =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "WORKER_DB_ROLE must be a lower-case SQL name (a-z 0-9 _)" >&2; exit 1; }
# This script resets the role's password and prints a URL with it. For `postgres` or a built-in pg_* role that would
# hand out a superuser (or a powerful built-in) login, so those names are refused before anything runs.
case $role in
  postgres|pg_*) echo "WORKER_DB_ROLE=$role is refused: that name is the superuser or a built-in role" >&2; exit 1 ;;
esac
pw=${WORKER_DB_PASSWORD:-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')}
[[ $pw =~ ^[A-Za-z0-9._~-]{24,}$ ]] || { echo "WORKER_DB_PASSWORD must be 24 or more of A-Z a-z 0-9 . _ ~ -" >&2; exit 1; }

if [ -n "${PSQL:-}" ]; then
  read -ra psql <<<"$PSQL"
else
  psql=(docker compose -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml
        exec -T cp_postgres psql -U postgres -d mergit_cp -v ON_ERROR_STOP=1 -q)
fi

# The password travels on stdin, never on a command line, where `ps` would show it.
{
  printf "\\\\set pw '%s'\n" "$pw"
  printf "\\\\set role '%s'\n" "$role"
  # db-role.sql reads the role name from this setting.
  cat <<'SQL'
SET mergit.worker_role = :'role';
-- A role that exists and is a superuser must never get a printed password and a worker's URL.
SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role' AND rolsuper) AS is_super \gset
\if :is_super
DO $$ BEGIN RAISE EXCEPTION 'that role is a superuser: refusing to reset its password or print a URL for it'; END $$;
\endif
-- The grants name these tables. Without them the GRANT would fail after the role was made, leaving a role with a
-- password and CONNECT but no rights. Fail first, before anything is created.
SELECT count(*) < 4 AS tables_missing FROM pg_tables
  WHERE schemaname = 'public' AND tablename IN ('jobs', 'pr_requests', 'plans', 'tasks') \gset
\if :tables_missing
DO $$ BEGIN RAISE EXCEPTION 'the tables jobs, pr_requests, plans and tasks do not exist yet: start the control plane (the API creates them) and run this again. No role was created'; END $$;
\endif
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'role', :'pw') \gexec
SQL
  cat deploy/worker-vm/db-role.sql
} | "${psql[@]}"

echo "role $role is ready. Put this in the worker VM's env file (use the private address, not a public one):"
echo "DATABASE_URL=postgres://${role}:${pw}@<private-ip-of-this-server>:5433/mergit_cp?sslmode=prefer"
