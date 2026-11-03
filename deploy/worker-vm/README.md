# The agent worker on its own VM (plan task O10, issue #26)

The worker starts sandbox containers through the host's Docker socket, and the sandboxes run code a model wrote. Whoever
controls the worker process controls its host, so it gets a VM with nothing else on it. This VM holds its agent keys,
model keys and one database role with limited rights (see step 4 for what it can still do). It has no gateway key, no treasury key, no web app and no database.

```
 worker VM ──(private network, :5433, role mergit_worker)──▶ server: cp_postgres
           ──https──▶ gateway.mergit.site  (receipt.sealed)
           ──https──▶ store.mergit.site    (receipt bundles)
           ──https──▶ api.mergit.site/v0/internal/progress   (live steps; allowed only from this VM's IP)
```

## 1. On the server (once)

1. A second Hetzner server in the same project, plus a private network joining both. Note the server's private address.
2. `deploy/.env` (git-ignored; compose reads it): `CP_DB_BIND=<server private ip>` and `WORKER_VM_IP=<worker VM public ip>`.
   Leave `CP_DB_BIND` unset and Postgres stays on loopback. Never set it to `0.0.0.0`: Docker's published ports skip the host firewall.
   Through that port only `mergit_worker` can log in (`deploy/postgres/pg_hba.conf`); the `postgres` superuser cannot,
   because its rule names only the containers' address range, which leaves out the Docker bridge gateway that a
   proxied connection to the port can arrive from.
3. `docker compose -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml -f deploy/compose.server.yaml up -d`.
4. Make the role (prints its URL once): `deploy/worker-vm/create-db-role.sh`. It needs `cp_postgres` running and the tables
   in place, which the API creates when it starts, so run it after step 3 and wait for the API first:
   `until docker compose -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml exec -T api python -c "import urllib.request as u; u.urlopen('http://localhost:8000/healthz', timeout=5)" 2>/dev/null; do sleep 2; done`.
   If the tables are missing the script stops before it creates anything. It grants only `jobs`, `pr_requests`
   (read and update) and `plans`, `tasks` (read). No sessions, users, wallets or email addresses. It also takes
   CONNECT on `mergit_cp` away from PUBLIC, so no role but the superuser and `mergit_worker` can open that database,
   and undoes any default privileges that would hand later tables to the role. Keep the default role name: pg_hba.conf
   lets only `mergit_worker` in from outside (`WORKER_DB_ROLE` exists for tests; it refuses `postgres`, `pg_*` and any existing
   superuser).
   This is a limit, not a guarantee of harmlessness: the worker needs `UPDATE` on `jobs` and `pr_requests`, and the
   grant is not narrowed to columns, so a compromised worker can rewrite the `result` and `pr_url` of any job it can
   update (and the other columns of those rows). It cannot read sessions, users, wallets or email addresses, and
   cannot touch any other table.
5. DNS: an A record for `api` to the server (it exists today). The Hetzner firewall stays 22, 80, 443; the private network is not filtered by it.

### The database link is not encrypted by default

`DATABASE_URL` uses `sslmode=prefer`, and the `postgres:16` image in `compose.controlplane.yaml` has no server
certificate, so the link carries the role's password handshake (SCRAM, not the password itself) and every query in
clear text over the private network between the two servers. This is accepted for now because that network is private
to the Hetzner project and the data the role can reach is limited to the job and plan tables. It is not safe on a
shared or public network. To encrypt it: give `cp_postgres` a certificate and key (`-c ssl=on -c ssl_cert_file=... -c
ssl_key_file=...`), change the worker line in `deploy/postgres/pg_hba.conf` from `host` to `hostssl`, and set
`sslmode=verify-full&sslrootcert=<ca file>` in `worker.env`. Nothing here is set up yet, and it has not been tried.

## 2. On the worker VM

```bash
git clone https://github.com/mergit-io/mergit.git && cd mergit/deploy/worker-vm
sudo install -d -o "$USER" /var/lib/mergit/workspaces
docker build -t mergit-sandbox:dev ../../control-plane/sandbox
mkdir deployments && scp server:mergit/mergit-contracts/deployments/{base-sepolia,agents-base-sepolia}.json deployments/
cp worker.env.example worker.env && chmod 600 worker.env      # fill it in: names only in the example, values never committed
docker compose build && ./preflight.sh                        # every line must say ok
docker compose up -d && docker compose logs -f
```

Expected in the log: `failed N jobs`, `reclaimed N jobs`, `removed N stale sandbox containers`, `removed N abandoned workspace directories`, then it polls.

## 3. Cutting over from the worker on the main server

The main server still runs a worker in `compose.controlplane.yaml`. Move in this order, so there is never a gap:

1. Start the VM worker (step 2) and confirm it claims a job: `docker compose logs worker | grep claimed`.
2. Then, on the server: `docker compose -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml rm -sf worker`.
3. A follow-up change deletes the `worker` service from `compose.controlplane.yaml` so `update.sh` stops recreating it. Until then a push to
   `main` brings the old worker back: run step 2 again, or remove it first.

Two workers on one queue are safe (`FOR UPDATE SKIP LOCKED`); they must have different `WORKER_ID`s.

## Things that go wrong

| Symptom | Cause |
| --- | --- |
| `another worker process is already running as 'x'` | Two processes share a `WORKER_ID`. Each id is one process. A worker killed on its own (crash, `kill -9`, `docker kill`) frees its id at once, but a power loss or a network cut does not: the database keeps the dead session, and so the lock, until its TCP keepalives or `tcp_user_timeout` give up, up to about 60 s (the settings in `mergit_worker/startup.py`; not measured). The worker waits for this itself: it retries the lock for `WORKER_ID_LOCK_GRACE_S` seconds (default 90, 0 = do not wait) and logs `held by another database session`. Only if the lock is still held after that does it exit 2, and Docker's restart policy retries. |
| `cannot reach the database at start-up` | Postgres is down or unreachable from the VM. The worker exits 1 and Docker's restart policy tries again. |
| `another process took the worker id ... while the database was unreachable` | After a database restart a second process claimed this id. This worker stops after its current job (exit 2). Give each process its own `WORKER_ID`. |
| `REQUIRE_ALL_AGENT_KEYS is set and these are missing` | `agents-base-sepolia.json` lists an agent with no `MERGIT_AGENT_KEY_<id>`. Add it, or the requester loses an attempt on that agent. |
| `WORKER_ID is not set` | The hostname is the container id and changes on every recreate, so the previous run's jobs and sandboxes are not found. Set it. |
| Live steps missing in the app, jobs still finish | The API rejected `/v0/internal/progress`: `WORKER_VM_IP` is wrong or unset. Progress is best-effort. |
| `database refused` in preflight | `CP_DB_BIND` unset, wrong private address, or the password: rerun `create-db-role.sh`. |
| A deploy killed a running job | The job is `error` and the next agent takes over. `stop_grace_period` is 40 minutes so `docker compose stop` and `down` wait for the job. A host reboot does not: drain first (`docker compose stop`), then reboot. |
| Disk filling | `docker system df` and `du -sh /var/lib/mergit/workspaces`. Old workspaces are swept at every start; images are not: `docker image prune`. |

A dead worker's jobs are reclaimed only when a worker next starts (lease: one hour). Watch that the VM is up:
`docker compose ps` should say `Up`, and `docker compose logs --since 10m` should show polling or claims.
