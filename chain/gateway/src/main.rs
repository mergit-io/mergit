//! mergit-gateway. Env: DATABASE_URL, RPC_URL, DEPLOYMENT_JSON or DEPLOYMENT_FILE, GATEWAY_KEY, ORCHESTRATOR_URL, VALIDATOR_URL,
//! GATEWAY_ADDR (default 0.0.0.0:8082), CONFIRMATIONS (default 2), DEADLINE_SLACK_SECS (default 60),
//! TREASURY_KEY (enables free credits), FREE_CREDITS_USDC_UNITS (5000000), CREDIT_PLAN_CAP_USDC_UNITS (default: the
//! free grant, so one plan may use all of it), CREDIT_PLANS_PER_DAY (3), EVENTS_TOKEN (required: the orchestrator's shared secret for /v0/events), AUDIT_TOKEN (required: the
//! validator's shared secret), CHAIN_EVENTS_TOKEN (required: sent to the orchestrator on /v0/chain-events). The credit
//! figures are parameters, not measurements.

use mergit_chain_client::{Contracts, Deployment, provider};
use mergit_gateway::{AppState, Config, app, keeper, outbox, watcher};
use std::time::Duration;

fn env(k: &str) -> anyhow::Result<String> {
    std::env::var(k).map_err(|_| anyhow::anyhow!("{k} is not set"))
}

fn num<T: std::str::FromStr>(k: &str, default: T) -> T {
    std::env::var(k)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let deployment = Deployment::from_env()?;
    let rpc = env("RPC_URL")?;
    let contracts = Contracts::new(&deployment, provider(&rpc, env("GATEWAY_KEY")?.parse()?)?);
    let db = sqlx::PgPool::connect(&env("DATABASE_URL")?).await?;
    sqlx::migrate!("./migrations").run(&db).await?;
    // The per-plan cap defaults to the grant itself: a cap set separately (it was 2 USDC against a 5 USDC grant) let the
    // New run page offer a budget the gateway would then refuse, and the refused plan was closed.
    let free_credits_units: u64 = num("FREE_CREDITS_USDC_UNITS", 5_000_000);
    let cfg = Config {
        orchestrator_url: env("ORCHESTRATOR_URL")?,
        validator_url: env("VALIDATOR_URL")?,
        confirmations: num("CONFIRMATIONS", 2),
        max_log_range: num("LOG_RANGE", watcher::MAX_RANGE),
        start_block: std::env::var("START_BLOCK")
            .ok()
            .and_then(|v| v.parse().ok()),
        deadline_slack_secs: num("DEADLINE_SLACK_SECS", 60),
        free_credits_units,
        credit_plan_cap_units: num("CREDIT_PLAN_CAP_USDC_UNITS", free_credits_units),
        credit_plans_per_day: num("CREDIT_PLANS_PER_DAY", 3),
        events_token: Some(env("EVENTS_TOKEN")?),
        audit_token: Some(env("AUDIT_TOKEN")?),
        chain_events_token: Some(env("CHAIN_EVENTS_TOKEN")?),
    };
    let mut state = AppState::new(db, contracts, deployment.clone(), cfg);
    match std::env::var("TREASURY_KEY") {
        Ok(k) => {
            state = state.with_treasury(Contracts::new(&deployment, provider(&rpc, k.parse()?)?))
        }
        Err(_) => tracing::warn!("TREASURY_KEY not set: free credits are disabled"),
    }

    let s = state.clone();
    tokio::spawn(async move {
        let http = reqwest::Client::new();
        loop {
            if let Err(e) = watcher::tick(&s).await {
                tracing::warn!(error = %e, "watcher round failed");
            }
            if let Err(e) = outbox::deliver_due(&s, &http).await {
                tracing::warn!(error = %e, "outbox round failed");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    let s = state.clone();
    tokio::spawn(async move {
        loop {
            if let Err(e) = keeper::tick(&s).await {
                tracing::warn!(error = %e, "keeper round failed");
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });

    let addr = std::env::var("GATEWAY_ADDR").unwrap_or_else(|_| "0.0.0.0:8082".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "mergit-gateway listening");
    axum::serve(listener, app(state)).await?;
    Ok(())
}
