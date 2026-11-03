//! The chain gateway: the only bridge between the orchestration service and the contracts.
//! It turns orchestration events into transactions (idempotently), turns contract events into orchestration
//! events (in chain order, through an outbox), asks the validator to audit each committed receipt, and
//! settles expired tasks.

pub mod commitments;
pub mod credits;
pub mod events;
pub mod ingress;
pub mod keeper;
pub mod outbox;
pub mod tx;
pub mod watcher;

use axum::Router;
use mergit_chain_client::{Contracts, Deployment};
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct Config {
    pub orchestrator_url: String,
    pub validator_url: String,
    /// Blocks to wait before acting on a log (2 on Base Sepolia; 0 in tests).
    pub confirmations: u64,
    /// Largest block range read per getLogs call (`LOG_RANGE`). Alchemy's free tier allows 10.
    pub max_log_range: u64,
    /// First block read when the watcher has no cursor yet (`START_BLOCK`); the deployment's deploy block when
    /// `None`. A fresh gateway on a public RPC can start near the head instead of replaying empty history.
    pub start_block: Option<u64>,
    /// Seconds past a task's deadline before the keeper returns it.
    pub deadline_slack_secs: u64,
    /// Free credits granted once per address (a parameter, not a measurement).
    pub free_credits_units: u64,
    /// Largest plan that credits may fund.
    pub credit_plan_cap_units: u64,
    /// Credit-funded plans per address per day.
    pub credit_plans_per_day: u32,
    /// Shared secret the orchestration service sends as `Authorization: Bearer <token>` on /v0/events. Only
    /// the orchestrator may drive the gateway key; with `None` every event is refused.
    pub events_token: Option<String>,
    /// The validator's shared secret, sent as `Authorization: Bearer <token>` on audit requests.
    pub audit_token: Option<String>,
    /// The orchestrator's shared secret, sent as `Authorization: Bearer <token>` on /v0/chain-events.
    pub chain_events_token: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub contracts: Arc<Contracts>,
    pub deployment: Deployment,
    pub cfg: Arc<Config>,
    /// One transaction at a time from the gateway key, so nonces never collide.
    pub tx_lock: Arc<tokio::sync::Mutex<()>>,
    /// The treasury's contracts, which fund credit plans. `None` disables free credits.
    pub treasury: Option<Arc<Contracts>>,
}

impl AppState {
    pub fn new(db: PgPool, contracts: Contracts, deployment: Deployment, cfg: Config) -> Self {
        Self {
            db,
            contracts: Arc::new(contracts),
            deployment,
            cfg: Arc::new(cfg),
            tx_lock: Default::default(),
            treasury: None,
        }
    }

    pub fn with_treasury(mut self, treasury: Contracts) -> Self {
        self.treasury = Some(Arc::new(treasury));
        self
    }
}

/// Refuses `/v0/events` without the shared token: whoever can post events drives the gateway's role on chain.
async fn require_token(
    axum::extract::State(s): axum::extract::State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let presented = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match (&s.cfg.events_token, presented) {
        (Some(expected), Some(got)) if constant_time_eq(expected.as_bytes(), got.as_bytes()) => {
            next.run(req).await
        }
        _ => (
            axum::http::StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"error": "UNAUTHORIZED"})),
        )
            .into_response(),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn app(state: AppState) -> Router {
    // Only the credits and commitments reads are called from browsers; events come server to server, with the shared token.
    let browser_reads = Router::new()
        .route("/v0/credits/{address}", axum::routing::get(credits::read))
        .route(
            "/v0/credits/account/{account}",
            axum::routing::get(credits::read_account),
        )
        .route("/v0/commitments", axum::routing::get(commitments::list))
        .layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods([axum::http::Method::GET]),
        );
    let events = Router::new()
        .route("/v0/events", axum::routing::post(ingress::receive))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_token,
        ));
    Router::new()
        .route("/healthz", axum::routing::get(|| async { "ok" }))
        .merge(events)
        .merge(browser_reads)
        .with_state(state)
}
