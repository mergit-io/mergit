"""What the public site must send, and how it answers a path that is not part of the app (deploy/Caddyfile).

A test that asserts a guard is there is worth more than one that asserts the happy path works: each of these
failed in the 2026-11-01 test run (no security headers; every unknown path, including /.env, answered 200
with the app shell). They read the file, so they run everywhere; the last one also asks Caddy itself when it
is installed.
"""

import re
import shutil
import subprocess
from datetime import UTC, datetime
from fnmatch import fnmatch
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CADDYFILE = ROOT / "deploy" / "Caddyfile"
PUBLIC = ROOT / "frontend" / "public"


def _text() -> str:
    return CADDYFILE.read_text()


def _site_block() -> str:
    match = re.search(r"(?ms)^mergit\.site, app\.mergit\.site \{.*?^\}", _text())
    assert match, "the mergit.site block is missing"
    return match.group(0)


def _snippet() -> str:
    match = re.search(r"(?ms)^\(site_headers\) \{.*?^\}", _text())
    assert match, "the site_headers snippet is missing"
    return match.group(0)


@pytest.mark.parametrize(
    "header",
    [
        "Strict-Transport-Security",
        "X-Frame-Options",
        "X-Content-Type-Options",
        "Referrer-Policy",
        "Permissions-Policy",
    ],
)
def test_every_response_of_the_site_carries_the_baseline_headers(header: str) -> None:
    # In the site block itself, outside the handle blocks, so the API's responses get them too.
    outside = re.sub(r"(?ms)^\thandle[^\n]*\{.*?^\t\}", "", _site_block())
    assert re.search(rf"(?m)^\t\t{header} ", outside), f"{header} is not set on every response"


def test_the_page_cannot_be_framed() -> None:
    assert re.search(r'X-Frame-Options "?DENY"?', _site_block())


def test_hsts_is_not_applied_to_subdomains_or_preloaded() -> None:
    hsts = re.search(r"Strict-Transport-Security \"([^\"]+)\"", _site_block())
    assert hsts, "no HSTS"
    assert "includeSubDomains" not in hsts.group(1) and "preload" not in hsts.group(1)
    assert int(re.search(r"max-age=(\d+)", hsts.group(1)).group(1)) >= 31536000  # pyright: ignore[reportOptionalMemberAccess]


def test_the_csp_is_report_only_until_someone_has_watched_it_on_a_deployed_page() -> None:
    snippet = _snippet()
    assert "Content-Security-Policy-Report-Only" in snippet
    assert not re.search(r"(?m)^\s*header\s+Content-Security-Policy\s", snippet), (
        "an enforcing CSP was added: it can break sign-in or the wallet if it was not watched first"
    )
    for must in ("default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"):
        assert must in snippet


def test_the_page_is_not_cached_but_assets_still_are() -> None:
    snippet = _snippet()
    assert re.search(r'header @shell Cache-Control "no-cache"', snippet)
    assert re.search(r"@shell not path /assets/\*", snippet)
    assert "immutable" in snippet


def test_an_unknown_path_is_a_404_not_the_app_shell() -> None:
    snippet = _snippet()
    assert "try_files {path} /index.html" not in snippet, "every unknown path would answer 200 with the app"
    assert re.search(r"(?m)^\trewrite @spa /index\.html$", snippet)


def test_the_apps_own_routes_still_reach_the_shell() -> None:
    match = re.search(r"(?m)^\t@spa path ([^\n]+)$", _snippet())
    assert match, "no @spa route list"
    patterns = match.group(1).split()
    # The router's top-level paths (frontend/src/app/paths.ts) and a few real deep links.
    for path in (
        "/",
        "/signin",
        "/demo",
        "/demo/runs",
        "/app",
        "/app/runs/new",
        "/app/proofs/abc",
        "/app/settings",
    ):
        assert any(fnmatch(path, p) for p in patterns), f"{path} would 404 instead of opening the app"
    for path in ("/.env", "/.git/config", "/nope-404", "/sitemap.xml", "/wp-login.php", "/v0/anything"):
        assert not any(fnmatch(path, p) for p in patterns), f"{path} must not fall back to the app"


def test_the_router_has_no_top_level_route_the_site_would_404() -> None:
    paths = (ROOT / "frontend" / "src" / "app" / "paths.ts").read_text()
    top_level = {
        m.group(1) for m in re.finditer(r'(?m)^\s+(?:landing|signIn|demo|liveApp):\s*"(/[^"]*)"', paths)
    }
    match = re.search(r"(?m)^\t@spa path ([^\n]+)$", _snippet())
    assert match and top_level
    patterns = match.group(1).split()
    missing = {p for p in top_level if not any(fnmatch(p, pat) for pat in patterns)}
    assert missing == set(), f"the app has routes the Caddyfile would answer with 404: {sorted(missing)}"


def test_robots_and_security_txt_exist_and_security_txt_has_not_expired() -> None:
    robots = (PUBLIC / "robots.txt").read_text()
    assert "User-agent: *" in robots and "Disallow: /app/" in robots
    security = (PUBLIC / ".well-known" / "security.txt").read_text()
    assert re.search(r"(?m)^Contact: \S+", security)
    expires = re.search(r"(?m)^Expires: (\S+)$", security)
    assert expires, "security.txt needs an Expires line (RFC 9116)"
    when = datetime.fromisoformat(expires.group(1).replace("Z", "+00:00"))
    assert when > datetime.now(UTC), "security.txt has expired: renew its Expires date"


@pytest.mark.skipif(shutil.which("caddy") is None, reason="caddy is not installed here")
def test_caddy_accepts_the_file() -> None:
    done = subprocess.run(
        ["caddy", "validate", "--config", str(CADDYFILE), "--adapter", "caddyfile"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stderr[-500:]
