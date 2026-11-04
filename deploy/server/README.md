# Hosting Mergit on the Hetzner server

One server (Hetzner CPX32, Nuremberg) runs everything that used to run on a laptop and on Render:

| Name | What | Served by |
| --- | --- | --- |
| `mergit.site`, `www.mergit.site` | the public site (mock data) | Caddy, static files |
| `app.mergit.site` | the same frontend on live Base Sepolia data | Caddy, static files |
| `gateway.mergit.site` | gateway (chain relay, credits) | Caddy, then `gateway:8082` |
| `store.mergit.site` | evidence store (receipt bundles) | Caddy, then `store:8081` |
| _(not public)_ | validator, Postgres | compose network only |
| `app.mergit.site/v0/{auth,account,plans,agents}` | orchestration API (control plane), same origin as the app | Caddy, then `api:8000`; needs `deploy/compose.controlplane.yaml` |
| `api.mergit.site` | the same API on its own name: browser routes, `/healthz`, and `/v0/internal/*` from the worker VM only (`WORKER_VM_IP`); everything else 404 | Caddy, then `api:8000`; needs an A record |
| _(its own VM)_ | the agent worker | `deploy/worker-vm/README.md` |

Everything is testnet money. The Hetzner firewall (`mergit-fw`) allows only 22, 80 and 443.

## 1. One-time setup on the server

The two repositories must sit side by side, because the compose file mounts `../../mergit-contracts/deployments`.

```bash
sudo install -d -o "$USER" -g "$USER" /srv/mergit/sites
mkdir -p ~/mergit && cd ~/mergit
git clone https://github.com/mergit-io/mergit.git
git clone https://github.com/mergit-io/mergit-contracts.git
```

## 2. Copy the secrets (from the machine that has them)

`deploy/secrets/testnet.env` holds the gateway, validator and treasury keys and the five service tokens. They must be
the same keys the contracts were deployed with, so copy the file; do not regenerate it.

```bash
ssh viscous@SERVER 'mkdir -p ~/mergit/mergit/deploy/secrets'
scp deploy/secrets/testnet.env viscous@SERVER:mergit/mergit/deploy/secrets/testnet.env
ssh viscous@SERVER 'chmod 600 ~/mergit/mergit/deploy/secrets/testnet.env'
```

**Stop the old stack first** (`docker compose -f deploy/compose.testnet.yaml down` on the laptop). Two gateways sending
transactions with the same key collide on nonces.

## 3. DNS (Spaceship, Advanced DNS)

Add A records to the server's IPv4 address for `gateway` and `store` now; they are new names, so nothing breaks.
Leave the Spacemail records (MX, SPF, DKIM) alone, and `research` as it is.

## 4. Start the stack and build the sites

```bash
cd ~/mergit/mergit
docker compose -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml -f deploy/compose.server.yaml up -d --build   # first build takes a while
deploy/server/build-sites.sh                                                                # both sites, about 10 minutes
docker compose -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml -f deploy/compose.server.yaml ps
docker compose -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml -f deploy/compose.server.yaml exec caddy caddy validate --config /etc/caddy/Caddyfile
```

Check the services once `gateway.` and `store.` resolve:

```bash
curl -s https://gateway.mergit.site/healthz; echo
curl -s https://store.mergit.site/healthz; echo
GATEWAY_URL=https://gateway.mergit.site deploy/smoke-credits.sh <your-wallet-address>   # from a machine with foundry
```

## 5. Cut the sites over from Render

1. Write down the current records for `@`, `www` and `app` (Render's values) so you can put them back.
2. Replace them with A records to the server's IPv4 address. An apex `@` cannot be a CNAME or ALIAS next to an A record, so remove the old one.
3. Caddy fetches the certificates on the first request after DNS flips; allow a few minutes. Watch with
   `docker compose ... logs -f caddy`.
4. Open `https://mergit.site`, `https://www.mergit.site` (should redirect) and `https://app.mergit.site`.

**Rollback:** put the old records back. Keep the Render sites up for a day or two after the cutover, then delete them.

## Updating

```bash
cd ~/mergit/mergit
deploy/server/update.sh            # pull both repos, rebuild services and both sites, then check /healthz
deploy/server/update.sh services   # only the Rust services and Caddy (fast)
deploy/server/update.sh app        # only the frontend: web or app
```

Render deployed on every push. The server does not by itself, so `.github/workflows/deploy.yml` runs `update.sh` over SSH
on every push to `main` (and by hand from the Actions tab, where you can pick `services`, `web` or `app`).

### Upgrading an existing deployment past per-agent providers (`PLANNER_PROVIDER`)

The hosted deployment calls models through OpenRouter: `mergit-coder-0` is `provider = "openrouter"`,
`anthropic/claude-sonnet-5` in `control-plane/agents.toml`, and the planner uses whatever `PLANNER_PROVIDER` in
`api.env` names. `PLANNER_PROVIDER` has no default, and `deploy/make-controlplane-env.sh` will not touch
`deploy/secrets/api.env` or `worker.env` once they exist, so a server set up before this change has files the new
code cannot start from. Nothing goes down because of it: `update.sh` builds the new images, then runs each
service's own start-up checks in them against the real env files (`python -m mergit_cp.preflight` and
`python -m mergit_worker.preflight`), and only then replaces the running containers. A missing
`PLANNER_PROVIDER`, or a provider with no key (a `worker.env` with only `GROQ_API_KEY`, say), fails the deploy
with one line naming the setting, never its value, and the old containers keep serving. The automatic deploy
shows red until the files are fixed.

To move the server to OpenRouter, on the server, once (the key is read without echo and never printed):

```bash
cd ~/mergit/mergit
read -rsp "OPENROUTER_API_KEY: " k; echo
for f in api worker; do grep -q '^OPENROUTER_API_KEY=' deploy/secrets/$f.env || echo "OPENROUTER_API_KEY=$k" >> deploy/secrets/$f.env; done; unset k
sed -i '/^PLANNER_PROVIDER=/d; /^PLANNER_MODEL=/d' deploy/secrets/api.env
printf 'PLANNER_PROVIDER=openrouter\nPLANNER_MODEL=anthropic/claude-haiku-4.5\n' >> deploy/secrets/api.env
grep '^PLANNER_MODELS=' deploy/secrets/api.env   # if set, every id in it must be an OpenRouter id (see below)
deploy/server/update.sh services   # runs the preflight again, then deploys
```

`PLANNER_MODELS` (the extra planner models a user may pick in Settings) are all sent to the planner's provider,
so with OpenRouter they must be OpenRouter ids priced in `prices.toml` (`anthropic/claude-sonnet-5`, ...). The
preflight refuses a native id such as `claude-sonnet-5` there (and an OpenRouter id on Anthropic), so the deploy
fails instead of every plan using it. Leave `PLANNER_MODELS` unset to offer only `PLANNER_MODEL`.

**Anthropic stays an option.** To call Anthropic's API directly instead, put `ANTHROPIC_API_KEY` (or
`ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_BASE_URL`) in the env files and set `PLANNER_PROVIDER=anthropic`,
`PLANNER_MODEL=claude-haiku-4-5` for the planner; for the agent, change `mergit-coder-0` in `agents.toml` to
`provider = "anthropic"`, `model = "claude-sonnet-5"` and commit it. Keeping both keys in the env files means
either can be switched to without touching secrets again.

`GROQ_BASE_URL`, `GROQ_MODEL` and `LLM_PROVIDER` are no longer read; a provider's endpoint and model live in
`control-plane/agents.toml`. Leaving them in the env files is harmless, but the API and the worker log a
warning at start-up naming any that are still set, so delete them.

### Once, on the first deploy after the compose network was pinned

`deploy/compose.controlplane.yaml` pins the stack's network to `172.30.9.0/24`, so `deploy/postgres/pg_hba.conf` can
name that exact range instead of `samenet`. A server that already ran the stack has that network with whatever
subnet Docker picked, so the first `update.sh` after this change has to replace it. Recent Compose (checked with
5.6.1) does that itself: it removes and recreates the network and restarts every container on it once, a short
outage of the whole stack; the database's data is in its volume and is kept. An older Compose may refuse instead,
saying the network needs to be recreated. Then, on the server, once:

```bash
C="docker compose -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml -f deploy/compose.server.yaml"
$C down          # stops the stack and removes its network; volumes (the databases, certificates) are kept
deploy/server/update.sh services
```

Check first that `172.30.9.0/24` is not already in use on the host (`docker network ls -q | xargs docker network
inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'`, and the private network's own range). If it is,
change it in `compose.controlplane.yaml` and `pg_hba.conf` together, in one commit.

### Automatic deploys: one-time setup

1. On your machine, make a key used for nothing else: `ssh-keygen -t ed25519 -N '' -f deploy_key -C github-deploy`.
2. On the server, add the public key to `~/.ssh/authorized_keys` as a single line that can run `update.sh` and nothing
   else (the workflow passes `all`, `services`, `web` or `app` as the "command"; `update.sh` rejects anything else):

   ```
   restrict,command="cd ~/mergit/mergit && deploy/server/update.sh $SSH_ORIGINAL_COMMAND" ssh-ed25519 AAAA... github-deploy
   ```

3. In the GitHub repo, Settings, Secrets and variables, Actions, add `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`
   (the private key file) and `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <host>`). Then delete the local key files.
4. Port 22 must be reachable from GitHub's runners; the Hetzner firewall (`mergit-fw`) currently allows it.

Deploys are gated on CI. `deploy.yml` starts when `control-plane` or `frontend` finishes on `main`, and it only deploys when
every CI run for that commit passed and the commit is still the tip of `main`. If CI failed, it says so in the run's
notice and deploys nothing. Two consequences: a push that touches neither workflow's paths (docs only, `deploy/` only)
does not deploy by itself, and a manual run from the Actions tab skips the checks. A build that fails on the server
leaves the running containers as they were, but a change that builds and misbehaves still goes live.

## Notes

- Data lives in Docker volumes (`pgdata`, `receipts`, `audits`, `caddy_data`). `docker compose down` keeps them;
  `down -v` deletes them. Hetzner backups are off, so take a snapshot from the console before the demo.
- Cost: CPX32 is billed by the hour up to a monthly cap, so delete the server (not just stop it) when it is no longer needed.


## Backups

Users, sessions, plans and the credits ledger live in two Postgres databases on Docker volumes (`cp_pgdata` and
`pgdata`). They survive restarts and redeploys; only `docker compose down -v` deletes them. Hetzner's automatic backups
are off, so dump them yourself:

```bash
deploy/server/backup.sh            # writes ~/backups/mergit_cp-<time>.sql.gz and mergit-<time>.sql.gz, keeps 14 days
```

Run it nightly from cron (`crontab -e`): `15 3 * * * cd ~/mergit/mergit && deploy/server/backup.sh >> ~/backups/backup.log 2>&1`.
Copy the directory off the server as well (`scp -r viscous@91.98.73.73:backups .`), because a dump on the same disk is
lost with the disk. To restore into a fresh database: `gunzip -c mergit_cp-<time>.sql.gz | docker compose exec -T cp_postgres psql -U postgres mergit_cp`.
Dumps contain email addresses and session-token hashes: keep them private.


## Wallet demand ("Notify me")

Only MetaMask works today. The wallet picker lists "Other wallets" as coming soon, with a **Notify me** button that
records which wallet someone wants (`POST /v0/wallet-interest`). Read the totals on the server:

```bash
deploy/server/wallet-interest.sh            # people per wallet, signed in versus anonymous
deploy/server/wallet-interest.sh --emails   # also the signed-in people to tell at launch (private)
```

It is a demand signal, not a verified count. A signed-in person is one row per wallet by account; a signed-out
visitor is one row per wallet per token their browser keeps, so one person on two browsers counts twice. New rows are
limited to 60 a minute across everyone (`WALLET_INTEREST_PER_MINUTE`).

## Groq key rotator (keyrelay)

`tools/keyrelay` is a small proxy in front of many Groq keys: the planner (`api`) and the agents (`worker`) call it
instead of Groq, and it keeps using one key until Groq answers 429, then moves that key to the bottom for its
`Retry-After` and retries on the next. Read `tools/keyrelay/README.md` first, including its three caveats: Groq's
limits may be per organization (so keys from one account share a limit), using many accounts' keys may breach the
terms, and there is no "credits left" to query.

It runs as a compose service **only when `deploy/secrets/keyrelay/keyrelay.toml` exists** (`update.sh` adds the
`keyrelay` profile when it does), publishes no port, and is reached by name (`keyrelay:8787`). Its files are in a
directory mount, and the container runs as `KEYRELAY_USER` (default `1000:1000`, the host user that owns the secrets).

One-time setup on the server. Run the commands one at a time, and **never paste a key into a chat or a ticket**:

```bash
cd ~/mergit/mergit
mkdir -p deploy/secrets/keyrelay && chmod 700 deploy/secrets/keyrelay
cp tools/keyrelay/keyrelay.docker.toml deploy/secrets/keyrelay/keyrelay.toml
head -c 24 /dev/urandom | base64 > deploy/secrets/keyrelay/proxy-token.txt && chmod 600 deploy/secrets/keyrelay/proxy-token.txt
```

Build `groq-keys.txt` on your laptop (one key per line; the **last** line is used first; include the key that is in
`api.env` today if you want to keep using it) and copy it over:

```bash
scp groq-keys.txt viscous@<server>:~/mergit/mergit/deploy/secrets/keyrelay/groq-keys.txt
ssh viscous@<server> chmod 600 '~/mergit/mergit/deploy/secrets/keyrelay/groq-keys.txt'
```

Check the keys, start the rotator, and point the API and worker at it (their `GROQ_API_KEY` becomes the proxy token,
so a real Groq key is no longer in those files):

```bash
C="docker compose --profile keyrelay -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml -f deploy/compose.server.yaml"
$C build keyrelay
$C run --rm keyrelay check --config /etc/keyrelay/keyrelay.toml      # valid / dead / limited per key, by index
TOKEN=$(cat deploy/secrets/keyrelay/proxy-token.txt)
sed -i "s|^GROQ_API_KEY=.*|GROQ_API_KEY=$TOKEN|" deploy/secrets/api.env deploy/secrets/worker.env
```

A provider's endpoint is no longer an env var read at container start: each provider's `base_url` lives in
`control-plane/agents.toml`'s `[providers.<name>]` table (control-plane/README.md, "Model provider"), baked into
the `api` and `worker` images at build time. To route Groq traffic through the rotator, set `[providers.groq]`'s
`base_url` to `http://keyrelay:8787/v1` in `agents.toml` and commit it — an edit made only on the server would be
reverted by the next deploy, since `update.sh` mirrors `origin/main` — then rebuild and recreate:

```bash
$C up -d --force-recreate --build keyrelay api worker
$C exec keyrelay keyrelay status --config /etc/keyrelay/keyrelay.toml   # which keys are ok / cooling / dead
$C logs --tail 20 keyrelay                                              # indexes only, never a key
```

If keyrelay is down, planning fails with a 502 and the API logs `planner model unavailable: ...`. To go back, restore
a real `GROQ_API_KEY` in `api.env` and `worker.env`, set `[providers.groq]`'s `base_url` in `agents.toml` back to
Groq's own endpoint (`https://api.groq.com/openai/v1`), commit, and rebuild and recreate `api` and `worker`.

## Free credits and redeem codes

Every account gets **5 USDC of free credits, once**. They are never renewed. The gateway keeps the ledger **per
account** (the control plane's user id), not per address, so linking more wallets does not earn more. When the 5 USDC
is spent, a plan is refused and the app tells the person to connect a wallet and pay as they go.

A **redeem code** gives an account more, once. It adds its amount to the free credits, so a 20 USDC code leaves its
owner with 25 USDC in total (make the code worth 15 if you want 20 in total). Plans funded from credits are still
limited to 3 a day (`CREDIT_PLANS_PER_DAY` on the gateway) and to `CREDIT_PLAN_CAP_USDC_UNITS` each, whatever the
account holds. The cap **defaults to the free grant** (5 USDC), so a new account can spend all of it on one plan; set
the variable only to make it smaller. The New run page and the API both read the cap from the gateway, so changing it
needs no frontend change.

```bash
deploy/server/redeem-code.sh create --usdc 20 --note "Asha, first try"      # prints the code once
deploy/server/redeem-code.sh create --usdc 20 --count 10 --expires-days 30   # ten codes that lapse in 30 days
deploy/server/redeem-code.sh list                                            # status of every code, never the code
deploy/server/redeem-code.sh revoke <code_id>                                # an unused code stops working
```

Codes look like `MRG-7K2Q-XD4M-9TPA-C3VH`. Only a keyed hash is stored, so a copy of the database reveals no code and
a lost code cannot be recovered (make another). The hash is keyed by `SESSION_SECRET`: rotating that secret makes every
unredeemed code unusable. A person redeems at **Wallet → Redeem code** (or "Have a code?" in the plan dialog), limited to
10 attempts an hour. The credit is delivered as a `credits.grant` event, retried for 7 days, once per code.

Unlimited accounts are deliberately not a thing. Unlimited credit would spend real testnet USDC from the treasury
without bound: give testers a large code instead.

## One site, and the demo at /demo

`mergit.site` is the whole site: the home page, the real app at `/app` (live Base Sepolia data), and the **demo at
`/demo`** (sample data, no sign-in). `app.mergit.site` and `www.mergit.site` redirect to `mergit.site`, keeping the path,
so every address shows the same thing. There is one build (`deploy/server/build-sites.sh`) and no separate demo site.

The demo is the same bundle in another mode, decided once from the address the page was loaded at. It calls no API,
gateway or chain, has its own browser storage (`mergit-demo-session`, never the real session), and every page carries a
banner saying the data is sample data. Moving between the demo and the rest of the site is always a full page load.
"View demo" on the home page is a plain link to `/demo`; "Get started" opens the real sign-in.

## When a deploy fails with "Diverging branches can't be fast-forwarded"

`update.sh` now mirrors `origin/main` (`sync-repo.sh`): it fetches and resets, so a rewritten history no longer stops a
deploy. It refuses to run over uncommitted edits to tracked files, never touches untracked files (the secrets), and
prints any local commit it drops (`git reflog` keeps them). A server that is **already** stuck still runs the old
`update.sh`, which fails the same way, so it needs one manual fix first. On the server, one line at a time:

```bash
cd ~/mergit/mergit
git fetch origin && git status -sb                 # "ahead N, behind M" means diverged
git log --oneline origin/main..HEAD                # commits that exist only on the server: anything you need?
git reset --hard origin/main                       # only if the answer is no; untracked files are not touched
git -C ../mergit-contracts fetch origin && git -C ../mergit-contracts status -sb
```
If the contracts checkout also says diverged, `git -C ../mergit-contracts reset --hard origin/main`. Then re-run the
deploy from the Actions tab ("Run workflow") or run `deploy/server/update.sh all` on the server.

The deploy workflow only counts an earlier run as "already deployed" when its `update.sh` step actually succeeded, and it
starts after the `rust` workflow as well as `control-plane` and `frontend`.


## One site on two hostnames

`mergit.site` and `app.mergit.site` serve the same live site: one Caddy block, one build. The page calls the API on
whichever hostname it was loaded from. Sign-in works from either, with three settings in `deploy/secrets/api.env`:

```
APP_DOMAIN=app.mergit.site        # GitHub and Google call back here (each allows one callback address)
EXTRA_DOMAINS=mergit.site         # wallet sign-in is accepted from this hostname too
COOKIE_DOMAIN=mergit.site         # the session cookie is shared, so signing in on one signs in on the other
```

Add the last two, then recreate the API (`docker compose ... up -d api`). Without them sign-in still works on
`app.mergit.site` only, and wallet sign-in from `mergit.site` is refused as "wrong domain". The cookie is also sent to
the other `*.mergit.site` hosts (gateway, store); they ignore it.
