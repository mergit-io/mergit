"""Does the repository exist, and the branch with it? Asked of GitHub before a plan is drafted, so a typo
costs nothing instead of a planner call and a plan that can never run.

This server holds no GitHub token (the worker does; see README), so it sees public repositories only, and a
private one reads as missing. That is the rule: a private repository is refused here as "not found or private"
rather than allowed and failed at run time. GitHub rate-limits unauthenticated callers by address, so anything
other than a clear 404 or 422 (a 403, a 429, a 5xx, no answer) is treated as "could not check" and planning
goes on; the worker would still find a missing repository later.
"""

import logging
from urllib.parse import quote, urlsplit

import httpx

log = logging.getLogger(__name__)

API = "https://api.github.com"


async def check(repo_url: str, ref: str, *, http: httpx.AsyncClient | None = None) -> list[str]:
    """Problems with the repository or ref (empty when fine, or when it could not be checked).

    Only github.com is asked; ``repo_url`` is already validated as ``https://<host>/<owner>/<repo>``."""
    parts = urlsplit(repo_url)
    if parts.hostname != "github.com":
        return []
    owner, name = parts.path.strip("/").removesuffix(".git").split("/", 1)
    name = name.removesuffix("/")
    base = f"{API}/repos/{quote(owner)}/{quote(name)}"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "mergit-control-plane"}
    client = http or httpx.AsyncClient(timeout=5.0)
    try:
        # One call resolves a branch, tag or commit; a failure needs a second, to say which part is missing.
        found = await client.get(f"{base}/commits/{quote(ref, safe='/')}", headers=headers)
        if found.status_code == 200:
            return []
        if found.status_code not in (404, 422):
            log.info("repository check skipped: GitHub answered %s", found.status_code)
            return []
        repo = await client.get(base, headers=headers)
    except httpx.HTTPError as exc:
        log.info("repository check skipped: %s", exc)
        return []
    finally:
        if http is None:
            await client.aclose()
    if repo.status_code == 404:
        return [f"{owner}/{name} was not found, or it is private"]
    if repo.status_code != 200:
        log.info("repository check skipped: GitHub answered %s", repo.status_code)
        return []
    return [f"{ref} is not a branch, tag or commit of {owner}/{name}"]
