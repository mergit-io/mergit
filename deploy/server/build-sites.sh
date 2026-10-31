#!/usr/bin/env bash
# Builds the site on the server into $SITES_DIR (default /srv/mergit/sites), which Caddy serves as mergit.site.
#   deploy/server/build-sites.sh [app|web|all]      (default: app; `all` is the same, kept for the update script)
# `web` is the old mock-data demo build and is no longer served. The app calls the API on its own origin (<domain>,
# proxied by Caddy); set API_URL to point it elsewhere.
# The app build reads the contract addresses from ../mergit-contracts/deployments/base-sepolia.json. Each site is built
# into a new directory and swapped in only when the build succeeded, so a failed build never takes a live site down.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
dep=${DEPLOYMENT_FILE:-$repo/../mergit-contracts/deployments/base-sepolia.json}
out=${SITES_DIR:-/srv/mergit/sites}
domain=${DOMAIN:-mergit.site}
what=${1:-app}

[ -f "$dep" ] || { echo "missing $dep: clone mergit-contracts next to this repository" >&2; exit 1; }
[ -d "$out" ] && [ -w "$out" ] || { echo "$out must exist and be writable: sudo install -d -o $USER -g $USER $out" >&2; exit 1; }
field() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$dep" "$1"; }

swap() { # swap <name>: replace $out/<name> with the freshly built $out/<name>.new
  rm -rf "$out/$1.old"
  if [ -d "$out/$1" ]; then mv "$out/$1" "$out/$1.old"; fi
  mv "$out/$1.new" "$out/$1"
  rm -rf "$out/$1.old"
}

build_web() {
  rm -rf "$out/web.new"
  docker build -f "$repo/deploy/docker/sites.Dockerfile" --target web-dist --output "$out/web.new" "$repo"
  swap web
}

build_app() {
  rm -rf "$out/app.new"
  docker build -f "$repo/deploy/docker/sites.Dockerfile" --target app-dist --output "$out/app.new" \
    --build-arg "VITE_API_URL=${API_URL:-https://$domain}" \
    --build-arg "VITE_GATEWAY_URL=https://gateway.$domain" \
    --build-arg "VITE_STORE_URL=https://store.$domain" \
    --build-arg "VITE_ESCROW=$(field escrow)" \
    --build-arg "VITE_RECEIPT_REGISTRY=$(field receipt_registry)" \
    --build-arg "VITE_IDENTITY=$(field identity)" \
    --build-arg "VITE_USDC=$(field usdc)" \
    --build-arg "VITE_DEPLOY_BLOCK=$(field deploy_block)" \
    --build-arg "VITE_CHAIN_ID=$(field chain_id)" \
    "$repo"
  swap app
}

case "$what" in
  web) build_web ;;
  app) build_app ;;
  all) build_app ;;
  *) echo "usage: $0 [web|app|all]" >&2; exit 2 ;;
esac
echo "built: $(ls "$out" | tr '\n' ' ')"
