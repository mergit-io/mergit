"""Every browser-facing API route must be forwarded by Caddy on mergit.site.

The web app and the API share that one origin (deploy/Caddyfile): a path Caddy does not list is answered by
the static site, so a new route works in tests and fails for people. A route added without a line in the
Caddyfile is what broke "Start the free trial".
"""

import re
from fnmatch import fnmatch
from pathlib import Path

from mergit_cp import auth, oauth, otp, routes_plans, routes_runs, wallet_interest

CADDYFILE = Path(__file__).resolve().parents[2] / "deploy" / "Caddyfile"

# Served to the gateway and the worker over the compose network, and deliberately not proxied.
INTERNAL = ("/v0/internal", "/v0/chain-events")


def _proxied_patterns() -> list[str]:
    text = CADDYFILE.read_text()
    block = re.search(r"(?m)^mergit\.site, app\.mergit\.site \{.*?@api path ([^\n]+)", text, re.S)
    assert block, "the mergit.site block has no `@api path` matcher"
    return block.group(1).split()


def _browser_paths() -> list[str]:
    routers = [
        auth.router,
        auth.account_router,
        oauth.router,
        otp.router,
        wallet_interest.router,
        routes_plans.router,
        routes_runs.router,
        routes_runs.agents_router,
    ]
    paths = {
        re.sub(r"\{[^}]+\}", "x", r.path) for router in routers for r in router.routes if hasattr(r, "path")
    }  # pyright: ignore[reportAttributeAccessIssue,reportUnknownMemberType,reportUnknownVariableType,reportUnknownArgumentType]
    return sorted(p for p in paths if not p.startswith(INTERNAL))


def test_every_browser_route_is_proxied_to_the_api() -> None:
    patterns = _proxied_patterns()
    missing = [p for p in _browser_paths() if not any(fnmatch(p, pat) for pat in patterns)]
    assert missing == [], f"mergit.site would serve the web app, not the API, for: {missing}"


def test_the_internal_routes_stay_off_the_public_origin() -> None:
    patterns = _proxied_patterns()
    for path in ("/v0/internal/progress", "/v0/chain-events"):
        assert not any(fnmatch(path, pat) for pat in patterns), f"{path} must not be proxied"


def test_the_check_would_notice_a_route_it_does_not_know() -> None:
    assert not any(fnmatch("/v0/brand-new/thing", pat) for pat in _proxied_patterns())
