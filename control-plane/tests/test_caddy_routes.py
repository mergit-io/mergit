"""Every browser-facing API route must be forwarded by Caddy on mergit.site.

The web app and the API share that one origin (deploy/Caddyfile): a path Caddy does not list is answered by
the static site, so a new route works in tests and fails for people. A route added without a line in the
Caddyfile is what broke "Start the free trial".
"""

import re
from fnmatch import fnmatch
from pathlib import Path

from mergit_cp import (
    auth,
    oauth,
    otp,
    routes_account,
    routes_plans,
    routes_reputation,
    routes_routing,
    routes_runs,
    wallet_interest,
)

CADDYFILE = Path(__file__).resolve().parents[2] / "deploy" / "Caddyfile"

# Served to the gateway and the worker over the compose network, and deliberately not proxied.
INTERNAL = ("/v0/internal", "/v0/chain-events")

# Browser routes that are withheld from the public origin because they are not safe to expose yet. None today:
# DELETE /v0/account was withheld until a deletion scrubbed what it left behind (accounts.delete_account). A
# route in this list must be a real route that the Caddyfile does not forward.
WITHHELD: tuple[str, ...] = ()


def _block(host: str) -> str:
    text = CADDYFILE.read_text()
    match = re.search(rf"^{re.escape(host)} \{{\n(.*?)\n\}}$", text, re.S | re.M)
    assert match, f"no {host} block in the Caddyfile"
    return match.group(1)


def _proxied_patterns() -> list[str]:
    """The browser routes: one shared snippet, imported by the site (mergit.site and app.mergit.site) and by
    api.mergit.site."""
    text = CADDYFILE.read_text()
    snippet = re.search(r"^\(api_routes\) \{\n\s*@api path ([^\n]+)\n\}", text, re.M)
    assert snippet, "the (api_routes) snippet has no `@api path` matcher"
    for host in ("mergit.site, app.mergit.site", "api.mergit.site"):
        assert "import api_routes" in _block(host), f"{host} must import the shared route list"
    return snippet.group(1).split()


def _browser_paths() -> list[str]:
    routers = [
        auth.router,
        auth.account_router,
        routes_account.router,
        oauth.router,
        otp.router,
        wallet_interest.router,
        routes_plans.router,
        routes_runs.router,
        routes_runs.agents_router,
        routes_reputation.router,
        routes_routing.router,
    ]
    paths = {
        re.sub(r"\{[^}]+\}", "x", r.path) for router in routers for r in router.routes if hasattr(r, "path")
    }  # pyright: ignore[reportAttributeAccessIssue,reportUnknownMemberType,reportUnknownVariableType,reportUnknownArgumentType]
    return sorted(p for p in paths if not p.startswith(INTERNAL) and p not in WITHHELD)


def test_every_browser_route_is_proxied_to_the_api() -> None:
    patterns = _proxied_patterns()
    missing = [p for p in _browser_paths() if not any(fnmatch(p, pat) for pat in patterns)]
    assert missing == [], f"mergit.site would serve the web app, not the API, for: {missing}"


def test_the_internal_routes_stay_off_the_public_origin() -> None:
    patterns = _proxied_patterns()
    for path in ("/v0/internal/progress", "/v0/chain-events"):
        assert not any(fnmatch(path, pat) for pat in patterns), f"{path} must not be proxied"


def test_withheld_routes_stay_off_the_public_origin() -> None:
    patterns = _proxied_patterns()
    for path in WITHHELD:
        assert not any(fnmatch(path, pat) for pat in patterns), f"{path} is withheld and must not be proxied"


def test_a_withheld_route_is_a_real_route() -> None:
    """A path left in WITHHELD after its route was removed or renamed would hide nothing and mislead."""
    paths = {
        r.path  # pyright: ignore[reportAttributeAccessIssue,reportUnknownMemberType,reportUnknownVariableType]
        for r in routes_account.router.routes
        if hasattr(r, "path")
    }
    assert set(WITHHELD) <= paths


def test_the_check_would_notice_a_route_it_does_not_know() -> None:
    assert not any(fnmatch("/v0/brand-new/thing", pat) for pat in _proxied_patterns())


def test_the_api_host_serves_only_what_it_means_to() -> None:
    """api.mergit.site used to proxy everything, so the worker's internal route and the API's docs pages
    were reachable from anywhere. Now: the browser routes, /healthz, and the internal route from the
    worker VM only."""
    block = _block("api.mergit.site")
    assert "handle @api {" in block and "handle /healthz {" in block
    assert re.search(r"handle \{\s*respond \"not found\" 404\s*\}", block), "the catch-all must be a 404"
    assert not re.search(r"handle \{\s*reverse_proxy", block), "a catch-all reverse_proxy exposes every route"


def test_the_internal_route_is_proxied_only_from_the_worker_vm() -> None:
    block = _block("api.mergit.site")
    matcher = re.search(r"@worker \{(.*?)\}", block, re.S)
    assert matcher, "no @worker matcher"
    assert "path /v0/internal/*" in matcher.group(1)
    assert "remote_ip {$WORKER_VM_IP:" in matcher.group(1), "the internal route must be limited by IP"
    assert "handle @worker" in block


def test_the_worker_vm_default_address_is_one_nothing_can_use() -> None:
    """If WORKER_VM_IP is unset the rule must admit nobody. 192.0.2.0/24 is reserved for documentation."""
    default = re.search(r"remote_ip \{\$WORKER_VM_IP:([^}]+)\}", CADDYFILE.read_text())
    assert default and default.group(1).startswith("192.0.2."), "the fallback must be a documentation address"
    compose = (CADDYFILE.parent / "compose.server.yaml").read_text()
    assert "WORKER_VM_IP: ${WORKER_VM_IP:-192.0.2.1}" in compose, (
        "compose must pass the same unusable default"
    )


def test_chain_events_is_never_reachable_through_caddy() -> None:
    """Only the gateway calls it, over the compose network. Comments may mention it; configuration may not."""
    config = "\n".join(
        line for line in CADDYFILE.read_text().splitlines() if not line.lstrip().startswith("#")
    )
    assert "chain-events" not in config


def _spa_patterns() -> list[str]:
    """The paths the site answers with the app's index.html (`@spa` in the site_headers snippet)."""
    matcher = re.search(r"^\s*@spa path ([^\n]+)$", CADDYFILE.read_text(), re.M)
    assert matcher, "no `@spa path` matcher in the Caddyfile"
    return matcher.group(1).split()


def test_the_public_agent_profile_survives_a_direct_visit() -> None:
    """https://mergit.site/agents/<name>.mergit.eth is the ENS `agent-endpoint[web]` value. Without a
    fallback to index.html a direct visit or a reload is a 404."""
    patterns = _spa_patterns()
    assert "/agents" in patterns and "/agents/*" in patterns
    assert any(fnmatch("/agents/coder-0.mergit.eth", pat) for pat in patterns)


def test_registration_files_are_served_as_files() -> None:
    """ENS agent registration files live at /registrations/<label>.json. Rewriting them to index.html
    would hand every ENS reader an HTML page instead of the JSON."""
    patterns = _spa_patterns()
    assert not any(fnmatch("/registrations/coder-0.json", pat) for pat in patterns)
    assert not any(pat.startswith("/registrations") for pat in patterns)


def test_the_ledger_page_survives_a_reload_and_its_files_are_served_as_files() -> None:
    """/ledger is the public final-ledger page; /ledger/<name>.json is the snapshot whose hash the ENS record
    `mergit.ledger` commits to. Rewriting the file to index.html would make every hash check fail."""
    patterns = _spa_patterns()
    assert "/ledger" in patterns
    assert not any(fnmatch("/ledger/final-123.json", pat) for pat in patterns)


def test_every_internal_route_can_reach_the_api_from_the_worker_vm() -> None:
    """A new worker-facing route must not end up proxied nowhere. Today: /v0/internal/progress."""
    block = _block("api.mergit.site")
    pattern = re.search(r"path (/v0/internal/\*)", block)
    assert pattern
    internal_paths = {
        re.sub(r"\{[^}]+\}", "x", r.path)
        for r in routes_runs.internal_router.routes
        if hasattr(r, "path")  # pyright: ignore[reportUnknownArgumentType]
    }  # pyright: ignore[reportAttributeAccessIssue,reportUnknownMemberType,reportUnknownVariableType]
    assert internal_paths, "the internal router has no routes?"
    uncovered = [p for p in internal_paths if not fnmatch(p, pattern.group(1))]
    assert uncovered == [], f"worker-facing routes the Caddy rule does not cover: {uncovered}"


def test_public_json_is_readable_from_the_other_site_host() -> None:
    """The registration URL on Base is https://mergit.site/registrations/<label>.json and the ledger URL on
    mainnet is on the same host, but the dashboard is also served from app.mergit.site. Without an
    Access-Control-Allow-Origin header that fetch is cross-origin and fails, so every ENS badge reads "not
    verified" and /ledger reads "unreachable" there."""
    text = CADDYFILE.read_text()
    matcher = re.search(r"^\s*@public_json path ([^\n]+)$", text, re.M)
    assert matcher, "no `@public_json path` matcher in the Caddyfile"
    patterns = matcher.group(1).split()
    for path in ("/registrations/coder-0.json", "/ledger/final-123.json"):
        assert any(fnmatch(path, pat) for pat in patterns), f"{path} must be CORS-readable"
    assert not any(fnmatch("/ledger", pat) or fnmatch("/app", pat) for pat in patterns)
    assert re.search(r"header @public_json Access-Control-Allow-Origin \"\*\"", text)
    assert "https://mergit.site" in re.search(r"connect-src ([^;]+);", text).group(1)  # pyright: ignore[reportOptionalMemberAccess]


def test_the_ledger_and_registration_files_are_not_reformatted_by_prettier() -> None:
    """The ledger snapshot's hash is the hash of its exact bytes. `npm run format` (and CI's format:check)
    must leave public/ledger and public/registrations alone, or the snapshot stops matching the ENS record."""
    ignore = (CADDYFILE.parents[1] / "frontend" / ".prettierignore").read_text().splitlines()
    assert "public/ledger/" in ignore and "public/registrations/" in ignore
