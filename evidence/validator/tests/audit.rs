//! The validator against real contracts on Anvil and a mock receipt store.

use alloy::primitives::{B256, U256, keccak256};
use alloy::signers::local::PrivateKeySigner;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::Utc;
use mergit_chain_client::testkit::{Agent, Chain};
use mergit_receipt::ReceiptBuilder;
use mergit_receipt::fixture::forge;
use mergit_spec::*;
use mergit_validator::{AppState, Outcome, app, audit_task, catch_up};
use serde_json::json;
use tower::ServiceExt;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const PLAN: &str = "3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b";
const FAIL: u8 = 2;
const INVALID: u8 = 3;
const PASS: u8 = 1;

struct World {
    chain: Chain,
    store: MockServer,
    agent: Agent,
    requester: PrivateKeySigner,
    data: tempfile::TempDir,
}

async fn world() -> World {
    let chain = Chain::start().await;
    let agent = chain.register_agent().await;
    let requester = PrivateKeySigner::random();
    chain.fund_eth(requester.address()).await;
    chain.mint_usdc(requester.address(), 10_000_000).await;
    chain
        .mint_usdc(chain.keys.treasury.address(), 10_000_000)
        .await;
    World {
        chain,
        store: MockServer::start().await,
        agent,
        requester,
        data: tempfile::tempdir().unwrap(),
    }
}

fn state(w: &World, audit_p: f64) -> AppState {
    AppState::new(
        w.chain.contracts(w.chain.keys.validator.clone()),
        w.chain.deployment.clone(),
        w.store.uri(),
        audit_p,
        w.data.path().into(),
    )
}

fn plan_id(n: u8) -> B256 {
    mergit_spec::plan_id(&format!("{PLAN}-{n}"))
}

/// Funds plan `n` (from the requester, or from the treasury as free credits) and locks one task in it.
async fn locked_task(w: &World, n: u8, credits: bool) -> B256 {
    let t = task_id(plan_id(n), 0, 1);
    if credits {
        let c = w.chain.contracts(w.chain.keys.treasury.clone());
        c.usdc
            .approve(w.chain.deployment.escrow, U256::from(1_000_000))
            .send()
            .await
            .unwrap()
            .get_receipt()
            .await
            .unwrap();
        c.escrow
            .fundPlanFor(plan_id(n), w.requester.address(), U256::from(1_000_000))
            .send()
            .await
            .unwrap()
            .get_receipt()
            .await
            .unwrap();
    } else {
        let c = w.chain.contracts(w.requester.clone());
        c.usdc
            .approve(w.chain.deployment.escrow, U256::from(1_000_000))
            .send()
            .await
            .unwrap()
            .get_receipt()
            .await
            .unwrap();
        c.escrow
            .fundPlan(plan_id(n), U256::from(1_000_000))
            .send()
            .await
            .unwrap()
            .get_receipt()
            .await
            .unwrap();
    }
    let g = w.chain.contracts(w.chain.keys.gateway.clone());
    let deadline = Utc::now().timestamp() as u64 + 1800;
    g.escrow
        .lockTask(
            t,
            plan_id(n),
            w.agent.agent_id,
            U256::from(1_000_000),
            deadline,
            jcs_hash(&approved_phi()),
        )
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    t
}

/// The predicate the requester approved; its hash is recorded when the task is locked.
fn approved_phi() -> Predicate {
    Predicate {
        kind: PREDICATE_KIND.into(),
        command: vec!["pytest".into()],
        expected_exit: 0,
        workdir: ".".into(),
        allowed_paths: None,
        artifact_hashes: None,
        timeout_s: 60,
    }
}

fn sealed(w: &World, t: B256, plan: B256, holds: bool) -> Bundle {
    sealed_with(w, t, plan, holds, approved_phi())
}

fn sealed_with(w: &World, t: B256, plan: B256, holds: bool, phi: Predicate) -> Bundle {
    let header = Header {
        version: VERSION.into(),
        task_id: t,
        plan_id: plan,
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
        exit_code: if holds { 0 } else { 1 },
        changed_paths: vec![],
        observed_artifact_hashes: Default::default(),
        stdout_digest: keccak256(b""),
        holds,
    };
    ReceiptBuilder::new(header)
        .unwrap()
        .seal_with_phi(
            result,
            Cost::default(),
            Utc::now(),
            &w.agent.runtime,
            &domain(w),
        )
        .unwrap()
}

fn domain(w: &World) -> alloy::sol_types::Eip712Domain {
    receipt_domain(
        w.chain.deployment.chain_id,
        w.chain.deployment.receipt_registry,
    )
}

/// Commits `b` on chain and has the store serve `served` for the task.
async fn commit_and_serve(w: &World, b: &Bundle, served: Option<&Bundle>) {
    let r = &b.receipt;
    let g = w.chain.contracts(w.chain.keys.gateway.clone());
    g.registry
        .commit(
            r.header.task_id,
            w.agent.agent_id,
            r.root,
            r.terminal_hash,
            r.body_hash,
            U256::from(r.meter.usd_micros),
            r.signature.clone(),
        )
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    // The validator fetches by the committed body hash, which cannot be squatted.
    let route = format!("/v0/bundles/{}", r.body_hash);
    let resp = match served {
        Some(s) => ResponseTemplate::new(200).set_body_json(s),
        None => ResponseTemplate::new(404).set_body_json(json!({"error": "NOT_FOUND"})),
    };
    Mock::given(method("GET"))
        .and(path(route))
        .respond_with(resp)
        .mount(&w.store)
        .await;
}

async fn verdict(w: &World, t: B256) -> (u8, u8) {
    let r = w
        .chain
        .contracts(w.chain.keys.validator.clone())
        .escrow
        .taskOf(t)
        .call()
        .await
        .unwrap();
    (r.verdict, r.state)
}

#[tokio::test]
async fn honest_receipt_gets_pass() {
    let w = world().await;
    let t = locked_task(&w, 1, false).await;
    let b = sealed(&w, t, plan_id(1), true);
    commit_and_serve(&w, &b, Some(&b)).await;
    assert_eq!(
        audit_task(&state(&w, 1.0), t).await.unwrap(),
        Outcome::Recorded("pass")
    );
    assert_eq!(verdict(&w, t).await, (PASS, 2));
    assert_eq!(
        w.chain
            .contracts(w.chain.keys.validator.clone())
            .usdc
            .balanceOf(w.agent.operator.address())
            .call()
            .await
            .unwrap(),
        U256::from(1_000_000)
    );
}

#[tokio::test]
async fn phi_false_gets_fail() {
    let w = world().await;
    let t = locked_task(&w, 2, false).await;
    let b = sealed(&w, t, plan_id(2), false);
    commit_and_serve(&w, &b, Some(&b)).await;
    assert_eq!(
        audit_task(&state(&w, 1.0), t).await.unwrap(),
        Outcome::Recorded("fail")
    );
    assert_eq!(verdict(&w, t).await.0, FAIL);
}

#[tokio::test]
async fn forged_body_gets_invalid() {
    let w = world().await;
    let t = locked_task(&w, 3, false).await;
    let honest = sealed(&w, t, plan_id(3), true);
    // The operator commits one receipt and serves another, re-signed so its own signature checks out.
    let forged = forge(
        honest.clone(),
        |b| b.receipt.ended_at = "2026-10-27T23:59:59.000Z".into(),
        &w.agent.runtime,
        &domain(&w),
    );
    commit_and_serve(&w, &honest, Some(&forged)).await;
    assert_eq!(
        audit_task(&state(&w, 1.0), t).await.unwrap(),
        Outcome::Recorded("invalid")
    );
    assert_eq!(verdict(&w, t).await.0, INVALID);
    let report = state(&w, 1.0).record(t).unwrap();
    assert!(
        report["report"]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r == "COMMITMENT_MISMATCH")
    );
}

#[tokio::test]
async fn missing_body_gets_fail() {
    let w = world().await;
    let t = locked_task(&w, 4, false).await;
    commit_and_serve(&w, &sealed(&w, t, plan_id(4), true), None).await;
    assert_eq!(
        audit_task(&state(&w, 1.0), t).await.unwrap(),
        Outcome::Recorded("fail")
    );
    assert_eq!(verdict(&w, t).await.0, FAIL);
}

#[tokio::test]
async fn store_down_records_no_verdict() {
    let w = world().await;
    let t = locked_task(&w, 5, false).await;
    let b = sealed(&w, t, plan_id(5), true);
    commit_and_serve(&w, &b, Some(&b)).await;
    let mut s = state(&w, 1.0);
    s.store_url = "http://127.0.0.1:9".into(); // nothing listens there
    assert!(audit_task(&s, t).await.is_err());
    assert_eq!(verdict(&w, t).await, (0, 1), "still locked, no verdict");
}

#[tokio::test]
async fn p_zero_draws_nothing_for_staked_but_audits_onboarding() {
    let w = world().await;
    let staked = locked_task(&w, 6, false).await;
    let b = sealed(&w, staked, plan_id(6), true);
    commit_and_serve(&w, &b, Some(&b)).await;
    let credits = locked_task(&w, 7, true).await;
    let c = sealed(&w, credits, plan_id(7), true);
    commit_and_serve(&w, &c, Some(&c)).await;
    let s = state(&w, 0.0);
    assert_eq!(audit_task(&s, staked).await.unwrap(), Outcome::NotDrawn);
    assert_eq!(verdict(&w, staked).await, (0, 1));
    assert_eq!(
        audit_task(&s, credits).await.unwrap(),
        Outcome::Recorded("pass")
    );
    // The draw is remembered: asking again does not redraw.
    assert_eq!(
        audit_task(&state(&w, 1.0), staked).await.unwrap(),
        Outcome::NotDrawn
    );
}

#[tokio::test]
async fn audit_request_is_idempotent() {
    let w = world().await;
    let t = locked_task(&w, 8, false).await;
    let b = sealed(&w, t, plan_id(8), true);
    commit_and_serve(&w, &b, Some(&b)).await;
    let s = state(&w, 1.0);
    assert_eq!(audit_task(&s, t).await.unwrap(), Outcome::Recorded("pass"));
    assert_eq!(audit_task(&s, t).await.unwrap(), Outcome::AlreadySettled);
}

#[tokio::test]
async fn catches_up_on_unverdicted_commitments_at_start() {
    let w = world().await;
    let a = locked_task(&w, 9, false).await;
    let b = locked_task(&w, 10, false).await;
    for (t, p) in [(a, plan_id(9)), (b, plan_id(10))] {
        let s = sealed(&w, t, p, true);
        commit_and_serve(&w, &s, Some(&s)).await;
    }
    assert_eq!(catch_up(&state(&w, 1.0)).await.unwrap(), 2);
    assert_eq!(verdict(&w, a).await.0, PASS);
    assert_eq!(verdict(&w, b).await.0, PASS);
}

#[tokio::test]
async fn http_audit_answers_202_and_audit_record_is_readable() {
    let w = world().await;
    let t = locked_task(&w, 11, false).await;
    let b = sealed(&w, t, plan_id(11), true);
    commit_and_serve(&w, &b, Some(&b)).await;
    let s = state(&w, 1.0).with_token("t");
    let req = Request::post("/v0/audit")
        .header("authorization", "Bearer t")
        .header("content-type", "application/json")
        .body(Body::from(json!({"task_id": t}).to_string()))
        .unwrap();
    assert_eq!(
        app(s.clone()).oneshot(req).await.unwrap().status(),
        StatusCode::ACCEPTED
    );
    for _ in 0..100 {
        if verdict(&w, t).await.0 != 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(verdict(&w, t).await.0, PASS);
    let res = app(s)
        .oneshot(
            Request::get(format!("/v0/audits/{t}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn audited_outcomes_are_anchored_with_cost_tier_and_category() {
    use alloy::providers::Provider;
    use alloy::rpc::types::Filter;
    use alloy::sol_types::SolEvent;
    use mergit_chain_client::abi::ReputationAnchor::OutcomeRecorded;
    let w = world().await;
    let pass = locked_task(&w, 12, false).await;
    let b = sealed(&w, pass, plan_id(12), true);
    commit_and_serve(&w, &b, Some(&b)).await;
    let credits = locked_task(&w, 13, true).await;
    let c = sealed(&w, credits, plan_id(13), false);
    commit_and_serve(&w, &c, Some(&c)).await;
    let s = state(&w, 1.0);
    audit_task(&s, pass).await.unwrap();
    audit_task(&s, credits).await.unwrap();
    let logs = s
        .contracts
        .provider
        .get_logs(
            &Filter::new()
                .address(w.chain.deployment.reputation_anchor)
                .event_signature(OutcomeRecorded::SIGNATURE_HASH)
                .from_block(0),
        )
        .await
        .unwrap();
    let outcomes: Vec<OutcomeRecorded> = logs
        .iter()
        .map(|l| l.log_decode::<OutcomeRecorded>().unwrap().inner.data)
        .collect();
    assert_eq!(outcomes.len(), 2);
    let p = outcomes.iter().find(|o| o.taskId == pass).unwrap();
    assert!(p.success);
    assert_eq!((p.tier, p.source), (0, 0), "staked tier, from an audit");
    assert_eq!(p.category, keccak256(b"test-repair"));
    assert_eq!(p.costMicros, U256::from(b.receipt.meter.usd_micros));
    let f = outcomes.iter().find(|o| o.taskId == credits).unwrap();
    assert!(!f.success);
    assert_eq!(
        f.tier, 1,
        "onboarding tier is recorded, so it can be kept out of staked-tier routing"
    );
}

#[tokio::test]
async fn a_receipt_for_a_predicate_other_than_the_approved_one_is_invalid() {
    let w = world().await;
    let t = locked_task(&w, 20, false).await;
    let mut own = approved_phi();
    own.command = vec!["true".into()]; // a check the agent wrote for itself
    let b = sealed_with(&w, t, plan_id(20), true, own);
    commit_and_serve(&w, &b, Some(&b)).await;
    let s = state(&w, 1.0);
    assert_eq!(
        audit_task(&s, t).await.unwrap(),
        Outcome::Recorded("invalid")
    );
    let reasons = s.record(t).unwrap()["report"]["reasons"].clone();
    assert!(
        reasons
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r == "PHI_HASH_MISMATCH"),
        "{reasons}"
    );
}

#[tokio::test]
async fn a_receipt_naming_another_plan_is_invalid() {
    let w = world().await;
    let t = locked_task(&w, 21, false).await;
    let b = sealed(&w, t, plan_id(99), true); // header plan id is not the task's plan
    commit_and_serve(&w, &b, Some(&b)).await;
    assert_eq!(
        audit_task(&state(&w, 1.0), t).await.unwrap(),
        Outcome::Recorded("invalid")
    );
}

#[tokio::test]
async fn a_squatted_task_slot_does_not_get_the_honest_operator_slashed() {
    let w = world().await;
    let t = locked_task(&w, 22, false).await;
    let honest = sealed(&w, t, plan_id(22), true);
    commit_and_serve(&w, &honest, Some(&honest)).await;
    // An attacker filled the by-task slot with junk; the validator must not read it.
    let junk = sealed(&w, t, plan_id(22), false);
    Mock::given(method("GET"))
        .and(path(format!("/v0/tasks/{t}/bundle")))
        .respond_with(ResponseTemplate::new(200).set_body_json(&junk))
        .mount(&w.store)
        .await;
    assert_eq!(
        audit_task(&state(&w, 1.0), t).await.unwrap(),
        Outcome::Recorded("pass")
    );
}

#[tokio::test]
async fn a_not_drawn_task_is_marked_on_chain_so_it_can_release() {
    let w = world().await;
    let t = locked_task(&w, 23, false).await;
    let b = sealed(&w, t, plan_id(23), true);
    commit_and_serve(&w, &b, Some(&b)).await;
    assert_eq!(
        audit_task(&state(&w, 0.0), t).await.unwrap(),
        Outcome::NotDrawn
    );
    let escrow = w.chain.contracts(w.chain.keys.validator.clone()).escrow;
    assert!(escrow.notDrawn(t).call().await.unwrap());
}

#[tokio::test]
async fn a_receipt_reporting_its_own_failure_is_always_audited() {
    let w = world().await;
    let t = locked_task(&w, 24, false).await;
    let b = sealed(&w, t, plan_id(24), false);
    commit_and_serve(&w, &b, Some(&b)).await;
    assert_eq!(
        audit_task(&state(&w, 0.0), t).await.unwrap(),
        Outcome::Recorded("fail"),
        "p = 0, yet audited"
    );
}

#[tokio::test]
async fn a_transport_error_reading_the_body_gives_no_verdict() {
    use tokio::io::AsyncWriteExt;
    let w = world().await;
    let t = locked_task(&w, 25, false).await;
    let b = sealed(&w, t, plan_id(25), true);
    commit_and_serve(&w, &b, None).await;
    // A store that promises a body and hangs up halfway.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            // Read the whole request first, so the failure is in the response body, not the request.
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                match tokio::io::AsyncReadExt::read(&mut sock, &mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            let _ = sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100000\r\n\r\n{\"receipt\":").await;
            let _ = sock.shutdown().await;
        }
    });
    let mut s = state(&w, 1.0);
    s.store_url = format!("http://{addr}");
    assert!(
        audit_task(&s, t).await.is_err(),
        "no verdict, try again later"
    );
    assert_eq!(verdict(&w, t).await, (0, 1));
}

#[tokio::test]
async fn catch_up_retries_a_deferred_audit_after_its_logs_were_scanned() {
    let w = world().await;
    let t = locked_task(&w, 26, false).await;
    let b = sealed(&w, t, plan_id(26), true);
    commit_and_serve(&w, &b, Some(&b)).await;
    let mut down = state(&w, 1.0);
    down.store_url = "http://127.0.0.1:9".into();
    assert_eq!(catch_up(&down).await.unwrap(), 0, "store down: deferred");
    // Same data directory, store back: the scan cursor has moved on, but the deferred task is retried.
    assert_eq!(catch_up(&state(&w, 1.0)).await.unwrap(), 1);
    assert_eq!(verdict(&w, t).await.0, PASS);
}

#[tokio::test]
async fn audit_requests_need_the_shared_token() {
    let w = world().await;
    let s = state(&w, 1.0).with_token("audit-secret");
    let body = json!({"task_id": B256::ZERO}).to_string();
    let no = Request::post("/v0/audit")
        .header("content-type", "application/json")
        .body(Body::from(body.clone()))
        .unwrap();
    assert_eq!(
        app(s.clone()).oneshot(no).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let yes = Request::post("/v0/audit")
        .header("content-type", "application/json")
        .header("authorization", "Bearer audit-secret")
        .body(Body::from(body))
        .unwrap();
    assert_eq!(
        app(s).oneshot(yes).await.unwrap().status(),
        StatusCode::ACCEPTED
    );
}
