//! Shared setup for the gateway tests: real contracts on Anvil, a real Postgres, mock HTTP peers.
#![allow(dead_code)]

use alloy::primitives::{B256, U256, keccak256};
use alloy::signers::local::PrivateKeySigner;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use chrono::Utc;
use mergit_chain_client::testkit::{Agent, Chain};
use mergit_gateway::{AppState, Config, app};
use mergit_receipt::ReceiptBuilder;
use mergit_spec::*;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

pub struct World {
    pub chain: Chain,
    pub state: AppState,
    pub orchestrator: MockServer,
    pub validator: MockServer,
    pub agent: Agent,
    pub requester: PrivateKeySigner,
}

pub const TOKEN: &str = "test-events-token";

pub const PLAN: &str = "3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b";

pub async fn world(pool: PgPool) -> World {
    world_with(pool, |_| {}).await
}

/// Testnet defaults from the plan: 5 USDC of credits, 2 USDC cap per plan, 3 credit plans a day.
pub async fn world_with(pool: PgPool, tweak: impl FnOnce(&mut Config)) -> World {
    let chain = Chain::start().await;
    let orchestrator = MockServer::start().await;
    let validator = MockServer::start().await;
    for s in [&orchestrator, &validator] {
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200))
            .mount(s)
            .await;
    }
    let mut cfg = Config {
        orchestrator_url: orchestrator.uri(),
        validator_url: validator.uri(),
        confirmations: 0,
        max_log_range: mergit_gateway::watcher::MAX_RANGE,
        start_block: None,
        deadline_slack_secs: 0,
        free_credits_units: 5_000_000,
        credit_plan_cap_units: 2_000_000,
        credit_plans_per_day: 3,
        events_token: Some(TOKEN.into()),
        audit_token: Some("test-audit-token".into()),
        chain_events_token: Some("test-chain-events-token".into()),
    };
    tweak(&mut cfg);
    chain
        .mint_usdc(chain.keys.treasury.address(), 100_000_000)
        .await;
    let state = AppState::new(
        pool,
        chain.contracts(chain.keys.gateway.clone()),
        chain.deployment.clone(),
        cfg,
    )
    .with_treasury(chain.contracts(chain.keys.treasury.clone()));
    let agent = chain.register_agent().await;
    let requester = PrivateKeySigner::random();
    chain.fund_eth(requester.address()).await;
    chain.mint_usdc(requester.address(), 10_000_000).await;
    World {
        chain,
        state,
        orchestrator,
        validator,
        agent,
        requester,
    }
}

pub fn plan_id() -> B256 {
    mergit_spec::plan_id(PLAN)
}

pub fn task(attempt: u32) -> B256 {
    task_id(plan_id(), 0, attempt)
}

pub async fn fund(w: &World, amount: u64) {
    let c = w.chain.contracts(w.requester.clone());
    c.usdc
        .approve(w.chain.deployment.escrow, U256::from(amount))
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    c.escrow
        .fundPlan(plan_id(), U256::from(amount))
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
}

pub fn envelope(event_id: &str, ty: &str, payload: Value) -> Value {
    json!({"event_id": event_id, "type": ty, "at": "2026-10-27T10:00:00.000Z", "payload": payload})
}

pub fn dispatch(w: &World, event_id: &str, attempt: u32, amount: u64) -> Value {
    dispatch_index(w, event_id, 0, attempt, amount)
}

pub fn dispatch_index(w: &World, event_id: &str, index: u32, attempt: u32, amount: u64) -> Value {
    envelope(
        event_id,
        "task.dispatch_requested",
        json!({
            "task_id": task_id(plan_id(), index, attempt), "plan_id": plan_id(), "index": index, "attempt": attempt,
            "agent_id": w.agent.agent_id.to_string(), "amount_usdc_units": amount.to_string(),
            "category": "test-repair", "phi_hash": B256::repeat_byte(3), "deadline_unix": Utc::now().timestamp() + 1800
        }),
    )
}

pub async fn post(w: &World, body: &Value) -> StatusCode {
    post_with(w, body, Some(TOKEN)).await
}

pub async fn post_with(w: &World, body: &Value, token: Option<&str>) -> StatusCode {
    let mut req = Request::post("/v0/events")
        .header(header::CONTENT_TYPE, "application/json")
        .header("Idempotency-Key", body["event_id"].as_str().unwrap_or("x"));
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    app(w.state.clone())
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
        .status()
}

pub async fn task_state(w: &World, t: B256) -> (U256, u8) {
    let r = w.state.contracts.escrow.taskOf(t).call().await.unwrap();
    (r.amount, r.state)
}

/// A real receipt for task `t`, signed by the agent's runtime key, as the Python worker would produce it.
pub fn sealed_for(w: &World, t: B256) -> Bundle {
    let phi = Predicate {
        kind: PREDICATE_KIND.into(),
        command: vec!["pytest".into()],
        expected_exit: 0,
        workdir: ".".into(),
        allowed_paths: None,
        artifact_hashes: None,
        timeout_s: 60,
    };
    let header = Header {
        version: VERSION.into(),
        task_id: t,
        plan_id: plan_id(),
        requester: w.requester.address(),
        agent_id: w.agent.agent_id.to_string(),
        category: "test-repair".into(),
        phi_hash: jcs_hash(&phi),
        phi,
        budget_usdc_units: "1000000".into(),
        runtime_image: "test".into(),
        attestation: Attestation::unattested(w.agent.runtime.address()),
        started_at: fmt_time(Utc::now()),
    };
    let result = PhiResult {
        exit_code: 0,
        changed_paths: vec![],
        observed_artifact_hashes: Default::default(),
        stdout_digest: keccak256(b""),
        holds: true,
    };
    let domain = receipt_domain(
        w.chain.deployment.chain_id,
        w.chain.deployment.receipt_registry,
    );
    ReceiptBuilder::new(header)
        .unwrap()
        .seal_with_phi(
            result,
            Cost::default(),
            Utc::now(),
            &w.agent.runtime,
            &domain,
        )
        .unwrap()
}

pub fn sealed_event(event_id: &str, b: &Bundle) -> Value {
    let r = &b.receipt;
    envelope(
        event_id,
        "receipt.sealed",
        json!({
            "task_id": r.header.task_id, "agent_id": r.header.agent_id, "root": r.root, "terminal_hash": r.terminal_hash,
            "body_hash": r.body_hash, "cost_micros": r.meter.usd_micros, "signature": r.signature
        }),
    )
}

pub async fn received_types(s: &MockServer) -> Vec<String> {
    s.received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| {
            serde_json::from_slice::<Value>(&r.body).unwrap()["type"]
                .as_str()
                .unwrap_or("")
                .to_string()
        })
        .collect()
}
