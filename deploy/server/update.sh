#!/usr/bin/env bash
# Redeploys on the server after a push (Render did this on every push; the server does not).
#   deploy/server/update.sh [all|services|web|app]      (default: all)
#   services = pull and rebuild the Rust services and Caddy;  web / app = rebuild that static site (about 10 minutes)
set -euo pipefail
cd "$(dirname "$0")/../.."
what=${1:-all}
# The key rotator runs only where it has been configured (see tools/keyrelay/README.md).
profiles=(); [ -f deploy/secrets/keyrelay/keyrelay.toml ] && profiles=(--profile keyrelay)
compose() { docker compose "${profiles[@]}" -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml -f deploy/compose.server.yaml "$@"; }

case "$what" in all|services|web|app) ;; *) echo "usage: $0 [all|services|web|app]" >&2; exit 2 ;; esac

# Mirror origin (see sync-repo.sh for why this is not `git pull --ff-only`).
. deploy/server/sync-repo.sh
sync_repo .
sync_repo ../mergit-contracts   # deployments/base-sepolia.json lives there

case "$what" in
  all|services)
    compose up -d --build
    # `git pull` replaces the Caddyfile with a new file, and a single-file bind mount keeps pointing at the old one,
    # so neither `up` nor `caddy reload` (which re-reads the stale copy and still succeeds) applies a changed
    # Caddyfile. Compare what the container sees with the file on disk; if they differ, or the container cannot be
    # asked, recreate it (certificates live in the caddy_data volume). Otherwise a reload is enough.
    if compose exec -T caddy cat /etc/caddy/Caddyfile | cmp -s - deploy/Caddyfile; then
      compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
    else
      echo "caddy: the container's Caddyfile differs from deploy/Caddyfile; recreating caddy"
      compose up -d --force-recreate --no-deps caddy
    fi ;;
esac
case "$what" in all) deploy/server/build-sites.sh all ;; web|app) deploy/server/build-sites.sh "$what" ;; esac

# `up -d` returns when the containers have started, not when the API has run its start-up migrations, so give it a
# moment instead of failing a good deploy on the first request. Returns 1 when it never answers; callers decide
# whether that is a failed deploy.
wait_until() {  # name command... (the command succeeds when the service answers)
  local name=$1 tries=${WAIT_TRIES:-30}; shift
  for _ in $(seq "$tries"); do
    if "$@" >/dev/null 2>&1; then echo "$name: ok"; return 0; fi
    sleep 2
  done
  return 1
}
api_inside() { compose exec -T api python -c \
  "import urllib.request as u; u.urlopen('http://localhost:8000/healthz', timeout=5).read()"; }
# Running now, by `docker compose ps`: a crashed or restarting container is not listed.
# The list is captured first: `grep -q` quits at its first match, and a `compose ps` still writing would then die of
# SIGPIPE, which `pipefail` turns into a failure for a service that is running. A failing `compose ps` fails too.
running() { local out; out=$(compose ps --status running --services) || return 1; grep -qx "$1" <<<"$out"; }
public() { curl -fsS -m 5 "https://$1.mergit.site/healthz"; }

compose ps
# The deploy has failed if the API does not answer on the compose network: that is the container itself.
wait_until "api (compose network)" api_inside || { echo "the api container did not answer /healthz" >&2; exit 1; }
# The gateway and the store have no check of their own inside the compose network (their images have no curl), so
# the deploy has failed if either container is not running.
for h in gateway store; do
  WAIT_TRIES=10 wait_until "$h (container)" running "$h" || { echo "the $h container is not running" >&2; exit 1; }
done
# The public URLs also need DNS and a certificate, which a new or moved server may not have yet. That is a warning
# only, because the containers above are up. If it persists after DNS is set, look at Caddy (`compose logs caddy`).
for h in gateway store api; do
  WAIT_TRIES=5 wait_until "$h (https://$h.mergit.site)" public "$h" \
    || echo "warning: https://$h.mergit.site/healthz did not answer from here. The containers are running, so this is DNS, a certificate not issued yet, or Caddy: the deploy itself succeeded" >&2
done
exit 0
