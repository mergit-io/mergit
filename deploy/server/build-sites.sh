#!/usr/bin/env bash
# Builds the site on the server into $SITES_DIR (default /srv/mergit/sites), which Caddy serves as mergit.site.
#   deploy/server/build-sites.sh [app|web|all]      (default: app; `all` is the same, kept for the update script)
# `web` is the old mock-data demo build and is no longer served. One build serves both mergit.site and app.mergit.site:
# the page calls the API on whichever hostname it was loaded from (API_URL=same-origin; set API_URL to point it
# elsewhere), and GitHub and Google sign-in always runs on https://app.<domain> (AUTH_ORIGIN), the one callback address
# they have registered.
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
# Like field, but prints nothing (and succeeds) when the deployment file has no such field.
optional_field() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$dep" "$1"; }

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
  # ENS lives on Ethereum mainnet (read-only). The addresses are the ENS deployment's own; the RPC can be changed with
  # ENS_RPC_URL (and then in the Caddyfile's connect-src too). The ReputationAnchor a `mergit.reputation` record must
  # name comes from the deployment file; an older file without `reputation_anchor` leaves the app's built-in default.
  local ens_args=(
    --build-arg "VITE_ENS_RPC_URL=${ENS_RPC_URL:-https://ethereum-rpc.publicnode.com}"
    --build-arg "VITE_ENS_UNIVERSAL_RESOLVER=${ENS_UNIVERSAL_RESOLVER:-0x06fdd07f007adac667177b46ab2eb9a75132cfd5}"
    --build-arg "VITE_ENS_REGISTRY=${ENS_REGISTRY:-0xf60aba43e1f7f3dab1186ff03b561401c9df85e2}"
  )
  local anchor
  anchor=$(optional_field reputation_anchor)
  if [ -n "$anchor" ]; then ens_args+=(--build-arg "VITE_REPUTATION_ANCHOR=$anchor"); fi
  docker build -f "$repo/deploy/docker/sites.Dockerfile" --target app-dist --output "$out/app.new" \
    --build-arg "VITE_API_URL=${API_URL:-same-origin}" \
    --build-arg "VITE_AUTH_ORIGIN=${AUTH_ORIGIN:-https://app.$domain}" \
    --build-arg "VITE_GATEWAY_URL=https://gateway.$domain" \
    --build-arg "VITE_STORE_URL=https://store.$domain" \
    --build-arg "VITE_ESCROW=$(field escrow)" \
    --build-arg "VITE_RECEIPT_REGISTRY=$(field receipt_registry)" \
    --build-arg "VITE_IDENTITY=$(field identity)" \
    --build-arg "VITE_USDC=$(field usdc)" \
    --build-arg "VITE_DEPLOY_BLOCK=$(field deploy_block)" \
    --build-arg "VITE_CHAIN_ID=$(field chain_id)" \
    "${ens_args[@]}" \
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
