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

compose ps
for h in gateway store; do printf '%s: ' "$h"; curl -fsS "https://$h.mergit.site/healthz"; echo; done
# The control-plane API has no /healthz; GET /v0/agents is public and answers 200 once Settings parses and
# the app starts (deploy/server/README.md, "Upgrading an existing deployment"). `-f` makes curl fail (and,
# with `set -e` above, this whole script fail) on a non-2xx or unreachable api, instead of `compose up`
# quietly leaving it restart-looping while this script still exits 0.
printf 'api: '; curl -fsS -o /dev/null -w '%{http_code}\n' "https://app.mergit.site/v0/agents"
