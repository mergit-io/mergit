"""Typed configuration. Every value comes from the environment; nothing here is a deployment fact."""

from typing import Annotated, cast

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from mergit_worker.providers import effective_model

BASE_SEPOLIA_CHAIN_ID = 84532


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    database_url: str
    app_domain: str
    """The SIWE domain the web app signs for, e.g. app.mergit.site. Messages for any other domain fail."""
    extra_domains: Annotated[list[str], NoDecode] = []
    """Other hostnames the same site is served on (app.mergit.site beside mergit.site). Wallet messages for
    them are accepted too. OAuth callbacks and redirects stay on ``app_domain``: GitHub takes one callback."""
    cookie_domain: str | None = None
    """When set (mergit.site), the session cookie is shared by that domain and its subdomains, so signing in
    on one of the site's hostnames signs in on the others. Unset, the cookie stays on the host that set it."""
    session_secret: SecretStr = Field(min_length=32)
    gateway_url: str
    store_url: str
    agents_file: str
    """deployments/agents.json from the contracts deployment: agent ids, operators, runtime keys."""
    agents_config: str = "agents.toml"
    """Model and system prompt per agent name."""
    cors_origins: Annotated[list[str], NoDecode] = []

    planner_model: str
    """The planner's model (HLD D18 is open, so this is a deployment choice, not a code default)."""
    prices_file: str = "prices.toml"
    planner_max_tasks: int = Field(default=8, ge=1, le=32)
    plans_per_hour: int = Field(default=10, ge=1)
    """Planner calls per requester per hour. Each one spends on the model before anything is funded."""
    redeem_attempts_per_hour: int = Field(default=10, ge=1)
    """Redeem-code attempts per account per hour, right or wrong, so a code cannot be guessed."""
    goal_max_chars: int = Field(default=8000, ge=1)
    repo_hosts: Annotated[list[str], NoDecode] = ["github.com"]
    """Hosts a plan's repository may live on. The worker clones it, so anything else is refused here."""
    max_attempts: int = Field(default=3, ge=1)
    """Agents a requester may list per task: the pick plus the retries (plan O6: at most 3 attempts)."""

    events_token: SecretStr
    """Shared secret sent to the gateway as ``Authorization: Bearer`` (spec/events-v0.md)."""
    chain_events_token: SecretStr
    """Shared secret the gateway must send as ``Authorization: Bearer`` on POST /v0/chain-events.

    spec/events-v0.md names a token for each of the other two legs (``EVENTS_TOKEN`` out,
    ``STORE_WRITE_TOKEN`` for the worker) but not this one; this is the one assumed for gateway to
    orchestrator, to confirm with Yash before go-live rather than leave the endpoint open.
    """
    event_retry_window_s: float = Field(default=600, gt=0)
    event_poll_s: float = Field(default=1.0, gt=0)
    event_timeout_s: float = Field(default=10.0, gt=0)
    outcome_poll_s: float = Field(default=1.0, gt=0)
    """How often finished jobs are checked for a retry, an escalation or plan completion (plan O6)."""
    reputation_poll_s: float = Field(default=5.0, gt=0)
    """How often finished tasks' costs are read from the gateway and the posteriors refreshed."""
    routing_epsilon: float = Field(default=0.1, ge=0)
    """Slack on the task budget when a suggestion skips an agent whose cost would not fit (paper §9.3)."""
    routing_min_observations: int = Field(default=5, ge=1)
    """Counted outcomes below which a suggested agent is called unproven."""
    reputation_cost_prior_micros: int = Field(default=500_000, ge=1)
    """The cost prior's mean for an agent with no history, in USDC micros. Configuration, not a measurement:
    it only matters until an agent has a few validated outcomes."""

    chain_id: int = BASE_SEPOLIA_CHAIN_ID
    nonce_ttl_s: int = Field(default=600, gt=0)
    session_ttl_s: int = Field(default=30 * 86400, gt=0)
    """How long a session lives after sign-in or after its last renewal. A session in use is slid forward
    once less than half of this remains (accounts.renew_session), so someone who keeps using the app stays
    signed in; one who stops is signed out after this long."""
    session_max_age_s: int = Field(default=90 * 86400, gt=0)
    """Hard cap from sign-in: sliding never extends a session past this, so everyone signs in again at least
    this often."""
    db_pool_max: int = Field(default=10, gt=0)

    github_client_id: str | None = None
    github_client_secret: SecretStr | None = None
    google_client_id: str | None = None
    google_client_secret: SecretStr | None = None
    """GitHub and Google sign-in are offered only when both halves of a pair are set."""
    oauth_state_ttl_s: int = Field(default=600, gt=0)

    smtp_host: str | None = None
    smtp_port: int = 587
    """587 means STARTTLS; 465 means TLS from the first byte."""
    smtp_user: str | None = None
    smtp_password: SecretStr | None = None
    smtp_from: str | None = None
    """Emailed sign-in codes are offered only when smtp_host and smtp_from are set."""
    wallet_interest_per_minute: int = Field(default=60, ge=1)
    """New "Notify me" rows accepted per minute, across everyone: a flood is slowed, not stored."""
    otp_ttl_s: int = Field(default=600, gt=0)
    otp_max_attempts: int = Field(default=5, ge=1)
    otp_sends_per_hour: int = Field(default=5, ge=1)

    worker_token: SecretStr
    """Shared secret the worker sends as ``Authorization: Bearer`` on POST /v0/internal/progress
    (plan task O7). Not named in spec/events-v0.md, which only covers the orchestrator-gateway leg;
    this is this service's own choice for its one worker-facing endpoint."""
    sse_poll_s: float = Field(default=1.0, gt=0)
    """How often GET /v0/plans/{id}/events re-reads plan and task state from the database. A step the
    worker posts to /v0/internal/progress is relayed to subscribers immediately, not on this timer."""

    @model_validator(mode="after")
    def _planner_model_follows_the_provider(self) -> "Settings":
        # On Groq the planner runs the Groq model, and the start-up price check and the recorded cost must
        # name
        # the model that really answers (mergit_worker/providers.py). Unchanged whenever Anthropic is the
        # provider.
        self.planner_model = effective_model(self.planner_model)
        return self

    @model_validator(mode="before")
    @classmethod
    def _blank_is_unset(cls, data: object) -> object:
        # `deploy/secrets/api.env` may carry `GITHUB_CLIENT_ID=` for a method that is not set up yet.
        if not isinstance(data, dict):
            return data
        values = cast(dict[str, object], data)
        return {k: v for k, v in values.items() if not (isinstance(v, str) and v.strip() == "")}

    @property
    def sign_in_domains(self) -> list[str]:
        """Every hostname a wallet may sign in for."""
        return [self.app_domain, *self.extra_domains]

    @property
    def public_origin(self) -> str:
        """Where the browser reaches the web app and this API (same origin behind Caddy)."""
        local = self.app_domain.split(":")[0] in ("localhost", "127.0.0.1")
        return f"{'http' if local else 'https'}://{self.app_domain}"

    @property
    def github_enabled(self) -> bool:
        return bool(self.github_client_id and self.github_client_secret)

    @property
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def email_enabled(self) -> bool:
        return bool(self.smtp_host and self.smtp_from)

    @field_validator("cors_origins", "repo_hosts", "extra_domains", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value
