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
    planner_models: Annotated[list[str], NoDecode] = []
    """Other planner models a user may choose in their settings (comma-separated), all served by
    ``planner_provider``. Empty: everyone gets ``planner_model``. See ``model_choices``."""
    prices_file: str = "prices.toml"
    planner_max_tasks: int = Field(default=8, ge=1, le=32)
    plans_per_hour: int = Field(default=10, ge=1)
    """Planner calls per requester per hour. Each one spends on the model before anything is funded."""
    redeem_attempts_per_hour: int = Field(default=10, ge=1)
    """Redeem-code attempts per account per hour, right or wrong, so a code cannot be guessed."""
    goal_max_chars: int = Field(default=8000, ge=1)
    repo_hosts: Annotated[list[str], NoDecode] = ["github.com"]
    """Hosts a plan's repository may live on. The worker clones it, so anything else is refused here."""
    verify_repos: bool = True
    """Ask GitHub whether the repository and branch exist (publicly) before a plan is drafted."""
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
    reputation_cost_batch: int = Field(default=200, ge=1)
    """Pending costs read from the gateway in one pass of ``record_missing_costs``; the rest wait for the
    next poll. Bounds one pass to a known number of sequential gateway requests, however large the backlog
    (an outage, or heavy volume) grows."""
    reputation_cost_budget_s: float = Field(default=10.0, gt=0)
    """A pass of ``record_missing_costs`` stops asking for more costs once it has run this long, even inside
    the batch above: a gateway that answers but is slow must not make one pass run arbitrarily long."""
    routing_epsilon: float = Field(default=0.1, ge=0)
    """Slack on the task budget when a suggestion skips an agent whose cost would not fit (paper §9.3)."""
    routing_min_observations: int = Field(default=5, ge=1)
    """Counted outcomes below which a suggested agent is called unproven."""
    routing_probation_s: int = Field(default=604800, gt=0)
    """How long, in seconds, an operator's agents are left out of suggestions after a proven falsification on
    any of their tasks (an invalid verdict or an upheld challenge, whatever the plan's funding). Paper §7.5
    iii sets ``p = 1`` for a probationary period without fixing its length, and audits rather than excludes;
    exclusion and seven days are our parameterisation, not the paper's."""
    routing_operator_concurrency_cap: int = Field(default=5, ge=1)
    """Unresolved dispatches (no release or return yet) an operator's agents may hold between them before
    its agents are left out of suggestions. Paper §7.5 ii caps concurrent exposure per operator and sizes
    the audit rate for the cap; nothing here sizes an audit rate yet. The value 5 (one column of the paper's
    table) and counting from dispatch rather than from execution are our parameterisation, not the paper's."""
    routing_min_feasible_probability: float = Field(default=0.01, gt=0, le=0.25)
    """The smallest chance that one Thompson draw of an agent's cost fits a task's budget (with
    ``routing_epsilon``) for an exploring suggestion to draw that agent at all; below it the agent is listed
    as over budget for that task. The chance is computed from the agent's cost posterior (the upper
    regularized incomplete gamma), once per agent and task, not per draw, so a lucky draw cannot bring such an
    agent back. Capped at 0.25 because an agent whose mean cost fits always has at least 1/e, so the cap
    keeps exploring from leaving out anything greedy would suggest. Paper §9.3 screens only each draw on
    budget (so an agent whose cost is merely uncertain is not shut out for good) and has no such floor; the
    floor and its value are our parameterisation, not the paper's."""
    suggestions_per_hour: int = Field(default=60, ge=1)
    """Exploring suggestions per requester per hour. Each one appends a replay record per task to
    ``routing_decisions``, which is append-only; greedy suggestions write nothing and are not limited."""
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

    arkiv_rpc_url: str | None = None
    """Arkiv's Rabdi testnet RPC (``https://rpc.rabdi.db-chain.testnet.arkiv.network``), used directly
    (``arkiv_query`` over httpx) for reads. Unset: the mirror and its read endpoint are both no-ops
    (``arkiv_enabled``)."""
    arkiv_access_key: SecretStr | None = None
    """Raises the public RPC's heavy rate limit; free, from ``hub.arkiv.network/access-keys``."""
    arkiv_owner_address: str | None = None
    """The service wallet's public address (not its key — this service never holds that; see
    ``chain/arkiv/``). Read-only, used to filter `read_decisions` by `$owner` so a spoofed entity
    with Mergit's own schema tag cannot show up in someone else's results."""
    arkiv_sidecar_url: str | None = None
    """The Arkiv write sidecar (`chain/arkiv/`), the only thing that holds the service wallet's private
    key and can sign a write Rabdi accepts (`arkiv_mirror.py`'s own docstring explains why the control
    plane cannot do this itself)."""
    arkiv_sidecar_token: SecretStr | None = None
    """Shared secret sent as ``Authorization: Bearer`` to the sidecar, same pattern as `worker_token`."""
    arkiv_entity_ttl_days: int = Field(default=30, ge=1)
    """How long a mirrored routing decision lives on Arkiv before it expires."""

    worker_token: SecretStr
    """Shared secret the worker sends as ``Authorization: Bearer`` on POST /v0/internal/progress
    (plan task O7). Not named in spec/events-v0.md, which only covers the orchestrator-gateway leg;
    this is this service's own choice for its one worker-facing endpoint."""
    sse_poll_s: float = Field(default=1.0, gt=0)
    """How often GET /v0/plans/{id}/events re-reads plan and task state from the database. A step the
    worker posts to /v0/internal/progress is relayed to subscribers immediately, not on this timer."""

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
    def model_choices(self) -> list[str]:
        """The planner models a user may choose: ``planner_model``, then ``planner_models``, once each."""
        return list(dict.fromkeys([self.planner_model, *self.planner_models]))

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

    @property
    def arkiv_enabled(self) -> bool:
        """Reads need only the RPC and the wallet's public address. A write additionally needs the
        sidecar reachable (`arkiv_mirror.write_decisions` raises its own clear error when it isn't,
        caught the same best-effort way as any other mirror failure)."""
        return bool(self.arkiv_rpc_url and self.arkiv_owner_address)

    @field_validator("cors_origins", "repo_hosts", "extra_domains", "planner_models", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value
