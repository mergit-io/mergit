# The agent worker on its own VM (plan task O10, issue #26)

The worker starts sandbox containers through the host's Docker socket, and the sandboxes run code a model wrote. Whoever
controls the worker process controls its host, so it gets a VM with nothing else on it. This VM holds its agent keys,
model keys and one restricted database role. It has no gateway key, no treasury key, no web app and no database.

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
   Through that port only `mergit_worker` can log in (`deploy/postgres/pg_hba.conf`); the `postgres` superuser cannot.
3. Make the role (prints its URL once): `deploy/worker-vm/create-db-role.sh`. It grants only `jobs`, `pr_requests`
   (read and update) and `plans`, `tasks` (read). No sessions, users, wallets or email addresses.
4. `docker compose -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml -f deploy/compose.server.yaml up -d`.
5. DNS: an A record for `api` to the server (it exists today). The Hetzner firewall stays 22, 80, 443; the private network is not filtered by it.

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
| `another worker process is already running as 'x'` | Two processes share a `WORKER_ID`. Each id is one process. A killed worker never blocks its own restart. |
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
