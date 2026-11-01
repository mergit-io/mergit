"""One site on two hostnames (mergit.site and app.mergit.site).

Sign-in has to work from either: wallet messages are checked against every hostname the site is served on
(and no other), and the session cookie is shared by both, so signing in on one signs in on the other. OAuth
callbacks stay on the main hostname (GitHub allows one callback URL), which is why the cookie is shared.
Run with `pytest -m postgres`.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from eth_account import Account
from fastapi.testclient import TestClient

from mergit_cp.app import create_app
from mergit_cp.config import Settings
from tests.test_auth import _now

pytestmark = pytest.mark.postgres

OTHER = "app.mergit.test"
MAIN = "mergit.test"


def _message(account: Account, nonce: str, domain: str) -> dict[str, str]:
    from eth_account.messages import encode_defunct
    from siwe import SiweMessage

    text = SiweMessage.model_validate(
        {
            "domain": domain,
            "address": account.address,
            "uri": f"https://{domain}",
            "version": "1",
            "chain_id": 84532,
            "issued_at": _now(),
            "nonce": nonce,
        }
    ).prepare_message()
    return {
        "message": text,
        "signature": account.sign_message(encode_defunct(text=text)).signature.to_0x_hex(),
    }


@pytest.fixture
def two_hosts(settings: Settings) -> Iterator[TestClient]:
    both = settings.model_copy(
        update={"app_domain": MAIN, "extra_domains": [OTHER], "cookie_domain": "mergit.test"}
    )
    with TestClient(create_app(both, deliver_events=False), base_url=f"https://{MAIN}") as c:
        yield c


def _nonce(c: TestClient) -> str:
    return c.get("/v0/auth/nonce").json()["nonce"]


def test_a_wallet_message_for_either_hostname_signs_in(two_hosts: TestClient) -> None:
    for domain in (MAIN, OTHER):
        account = Account.create()
        body = _message(account, _nonce(two_hosts), domain)
        assert two_hosts.post("/v0/auth/verify", json=body).status_code == 200, domain


def test_a_wallet_message_for_any_other_hostname_is_refused(two_hosts: TestClient) -> None:
    for domain in ("evil.example", "mergit.test.evil.example", f"x.{OTHER}", "gateway.mergit.test"):
        body = _message(Account.create(), _nonce(two_hosts), domain)
        assert two_hosts.post("/v0/auth/verify", json=body).status_code == 401, domain


def test_with_no_extra_hostnames_only_the_main_one_is_accepted(settings: Settings) -> None:
    single = settings.model_copy(update={"app_domain": MAIN})
    with TestClient(create_app(single, deliver_events=False), base_url=f"https://{MAIN}") as c:
        assert c.post("/v0/auth/verify", json=_message(Account.create(), _nonce(c), OTHER)).status_code == 401


def test_the_session_cookie_is_shared_by_both_hostnames(two_hosts: TestClient) -> None:
    ok = two_hosts.post("/v0/auth/verify", json=_message(Account.create(), _nonce(two_hosts), MAIN))
    assert ok.status_code == 200
    cookie = ok.headers["set-cookie"].lower()
    assert "domain=mergit.test" in cookie
    assert "httponly" in cookie and "secure" in cookie


def test_logging_out_clears_the_shared_cookie_on_both_hostnames(two_hosts: TestClient) -> None:
    two_hosts.post("/v0/auth/verify", json=_message(Account.create(), _nonce(two_hosts), MAIN))
    out = two_hosts.post("/v0/auth/logout")
    assert out.status_code == 204
    cleared = out.headers["set-cookie"].lower()
    assert (
        "domain=mergit.test" in cleared
    )  # a cookie with a domain is only cleared by one with the same domain
    assert "max-age=0" in cleared


def test_without_a_cookie_domain_the_cookie_stays_on_one_host(settings: Settings) -> None:
    single = settings.model_copy(update={"app_domain": MAIN})
    with TestClient(create_app(single, deliver_events=False), base_url=f"https://{MAIN}") as c:
        ok = c.post("/v0/auth/verify", json=_message(Account.create(), _nonce(c), MAIN))
        assert "domain=" not in ok.headers["set-cookie"].lower()


def test_oauth_callbacks_stay_on_the_main_hostname(settings: Settings) -> None:
    both = settings.model_copy(update={"app_domain": MAIN, "extra_domains": [OTHER]})
    assert both.public_origin == f"https://{MAIN}"


def test_the_extra_hostnames_come_from_a_comma_separated_setting(settings: Settings) -> None:
    parsed = Settings.model_validate({**settings.model_dump(), "extra_domains": " a.test , b.test ,"})
    assert parsed.extra_domains == ["a.test", "b.test"]
    assert Settings.model_validate({**settings.model_dump(), "extra_domains": ""}).extra_domains == []


def test_a_blank_cookie_domain_means_none(settings: Settings) -> None:
    assert Settings.model_validate({**settings.model_dump(), "cookie_domain": ""}).cookie_domain is None
