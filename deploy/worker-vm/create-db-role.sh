#!/usr/bin/env bash
# Creates the worker VM's database role (mergit_worker) with only the rights in db-role.sql, or resets its password.
#   deploy/worker-vm/create-db-role.sh                          # makes a password and prints it once
#   WORKER_DB_PASSWORD=... deploy/worker-vm/create-db-role.sh   # uses one you chose (A-Z a-z 0-9 . _ ~ -, 24+ long)
# Run it on the server that runs cp_postgres, after the control plane has started once (it creates the tables).
# Safe to run again: it re-sets the password and takes back any right that is not in db-role.sql.
# PSQL replaces how psql is reached, for testing this script against a throwaway database.
set -euo pipefail
cd "$(dirname "$0")/../.."

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
  cat <<'SQL'
SELECT format('CREATE ROLE mergit_worker LOGIN PASSWORD %L', :'pw')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mergit_worker') \gexec
SELECT format('ALTER ROLE mergit_worker LOGIN PASSWORD %L', :'pw') \gexec
SQL
  cat deploy/worker-vm/db-role.sql
} | "${psql[@]}"

echo "role mergit_worker is ready. Put this in the worker VM's env file (use the private address, not a public one):"
echo "DATABASE_URL=postgres://mergit_worker:${pw}@<private-ip-of-this-server>:5433/mergit_cp?sslmode=prefer"
