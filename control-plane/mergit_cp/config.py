"""Typed configuration. Every value comes from the environment; nothing here is a deployment fact."""

from typing import Annotated, cast

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

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
    planner_provider: str
    """Which `[providers.<name>]` table in `agents_config` the planner uses (HLD D18 is open, so this is a
    deployment choice, not a code default)."""
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

    chain_id: int = BASE_SEPOLIA_CHAIN_ID
    nonce_ttl_s: int = Field(default=600, gt=0)
    session_ttl_s: int = Field(default=12 * 3600, gt=0)
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

    reputation_pooling_weight: float = Field(default=0.25, gt=0)
    """Weight `w` for pooling an agent-level posterior toward the base prior (paper 8.5). Our
    parameterisation, not the paper's."""
    reputation_value_ref_usdc_units: int = Field(default=1_000_000, gt=0)
    """Reference budget size `value_ref` for the update-weight value term (paper 8.7). Our
    parameterisation, not the paper's."""
    router_prior_cost_micros: int = Field(default=200_000, gt=0)
    """Prior mean cost, in micro-USD, seeded into a fresh agent's Gamma posterior (paper 8.2). Our
    parameterisation, not the paper's."""
    router_probation_s: int = Field(default=604800, gt=0)
    """How long a proven falsification (paper 7.5 iii) keeps an operator's agents in probation, once a
    later task reads `in_probation`. One week by default. Our parameterisation, not the paper's."""
    reputation_poll_s: float = Field(default=1.0, gt=0)
    """How often money_events and jobs are checked for new reputation observations, the same convention
    as `outcome_poll_s`/`event_poll_s`/`sse_poll_s`."""
    router_operator_concurrency_cap: int = Field(default=5, ge=1)
    """How many unresolved dispatches one operator's agents may carry at once before every one of that
    operator's agents is ineligible for a new auto-routed task (paper 7.5 ii). Our parameterisation, not
    the paper's."""
    router_explore_cap_per_operator: int = Field(default=2, ge=0)
    """How many unresolved exploratory draws one operator may hold at once before a further exploratory
    pick for that operator is redirected to the deterministic greedy choice instead (paper 7.5). Our
    parameterisation, not the paper's."""
    router_budget_tolerance: float = Field(default=0.1, ge=0)
    """How far over a task's budget a sampled cost may still count as feasible, as a fraction of the
    budget (paper 9.4's Thompson draw). Our parameterisation, not the paper's."""
    router_min_feasible_probability: float = Field(default=0.01, gt=0, le=0.25)
    """The smallest chance, per Thompson draw, that an agent's sampled cost fits a task's budget (with
    `router_budget_tolerance`) for the router to still consider that agent for that task at all. Below it
    the agent is "over budget for this task". The capacity sweep re-draws every `outcome_poll_s`, so any
    non-zero chance would eventually dispatch an agent the router itself expects to overrun the budget,
    after a silent wait of about `outcome_poll_s / p`. An auto task with no untried agent at or above it
    (or, with exploring off, none whose mean cost fits) is reported as needing the requester instead of
    left waiting. Capped at 0.25 so an agent whose mean cost fits can never fall under it (see
    `routing.over_budget`). Our parameterisation, not the paper's."""

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
