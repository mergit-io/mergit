//! The gateway against real contracts on Anvil, a real Postgres (DATABASE_URL) and mock HTTP peers.
//! Needs anvil, forge, mergit-contracts next to this repository, and Postgres.

mod common;

use alloy::primitives::U256;
use alloy::providers::Provider;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::*;
use mergit_gateway::{app, keeper, outbox, watcher};
use mergit_spec::task_id;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

#[sqlx::test(migrations = "./migrations")]
async fn duplicate_dispatch_event_locks_once(pool: PgPool) {
    let w = world(pool).await;
    fund(&w, 3_000_000).await;
    let e = dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a70", 1, 1_000_000);
    assert_eq!(post(&w, &e).await, StatusCode::OK);
    assert_eq!(post(&w, &e).await, StatusCode::OK, "same event id again");
    let again = dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a71", 1, 1_000_000);
    assert_eq!(
        post(&w, &again).await,
        StatusCode::OK,
        "new event id, same task"
    );
    assert_eq!(task_state(&w, task(1)).await, (U256::from(1_000_000), 1));
    let plan = w
        .state
        .contracts
        .escrow
        .planOf(plan_id())
        .call()
        .await
        .unwrap();
    assert_eq!(plan.available, U256::from(2_000_000), "locked exactly once");
}

#[sqlx::test(migrations = "./migrations")]
async fn sealed_receipt_is_committed_on_chain(pool: PgPool) {
    let w = world(pool).await;
    fund(&w, 1_000_000).await;
    post(
        &w,
        &dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a72", 1, 1_000_000),
    )
    .await;
    let b = sealed_for(&w, task(1));
    assert_eq!(
        post(
            &w,
            &sealed_event("6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a73", &b)
        )
        .await,
        StatusCode::OK
    );
    let c = w
        .state
        .contracts
        .registry
        .commitmentOf(task(1))
        .call()
        .await
        .unwrap();
    assert_eq!(c.root, b.receipt.root);
    assert!(c.committedAt > 0);
    // Sending it again is a no-op, not a revert.
    assert_eq!(
        post(
            &w,
            &sealed_event("6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a74", &b)
        )
        .await,
        StatusCode::OK
    );
}

/// A hosted RPC caps getLogs ranges (Alchemy's free tier allows 10 blocks), so the watcher reads in slices and
/// the events must still come out whole and in order.
#[sqlx::test(migrations = "./migrations")]
async fn watcher_reads_in_small_slices_without_losing_or_reordering_events(pool: PgPool) {
    let w = world_with(pool, |c| c.max_log_range = 1).await;
    fund(&w, 1_000_000).await;
    post(
        &w,
        &dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a85", 1, 1_000_000),
    )
    .await;
    post(
        &w,
        &sealed_event(
            "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a86",
            &sealed_for(&w, task(1)),
        ),
    )
    .await;
    let head = w.state.contracts.provider.get_block_number().await.unwrap();
    let mut ticks = 0;
    loop {
        watcher::tick(&w.state).await.unwrap();
        ticks += 1;
        let cursor: i64 = sqlx::query_scalar("select block from watcher_cursor where id = 1")
            .fetch_one(&w.state.db)
            .await
            .unwrap();
        if cursor as u64 > head {
            break;
        }
        assert!(ticks < 500, "the watcher never reached the head");
    }
    assert!(ticks > 1, "a one-block range needs more than one round");
    outbox::deliver_due(&w.state, &reqwest::Client::new())
        .await
        .unwrap();
    assert_eq!(
        received_types(&w.orchestrator).await,
        vec!["plan.funded", "task.escrowed", "receipt.committed"]
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn watcher_emits_events_in_chain_order(pool: PgPool) {
    let w = world(pool).await;
    fund(&w, 1_000_000).await;
    post(
        &w,
        &dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a75", 1, 1_000_000),
    )
    .await;
    post(
        &w,
        &sealed_event(
            "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a76",
            &sealed_for(&w, task(1)),
        ),
    )
    .await;
    watcher::tick(&w.state).await.unwrap();
    outbox::deliver_due(&w.state, &reqwest::Client::new())
        .await
        .unwrap();
    assert_eq!(
        received_types(&w.orchestrator).await,
        vec!["plan.funded", "task.escrowed", "receipt.committed"]
    );
    let audits = w.validator.received_requests().await.unwrap();
    assert_eq!(
        audits[0]
            .headers
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap(),
        "Bearer test-audit-token",
        "the validator only accepts audit requests carrying its token"
    );
    assert_eq!(audits.len(), 1);
    for r in w.orchestrator.received_requests().await.unwrap() {
        assert_eq!(
            r.headers.get("authorization").map(|v| v.to_str().unwrap()),
            Some("Bearer test-chain-events-token"),
            "the orchestrator only accepts chain events carrying its token"
        );
    }
    let body: Value = serde_json::from_slice(&audits[0].body).unwrap();
    assert_eq!(body["task_id"].as_str().unwrap(), task(1).to_string());
    // A second tick sees nothing new.
    watcher::tick(&w.state).await.unwrap();
    outbox::deliver_due(&w.state, &reqwest::Client::new())
        .await
        .unwrap();
    assert_eq!(received_types(&w.orchestrator).await.len(), 3);
}

#[sqlx::test(migrations = "./migrations")]
async fn outgoing_events_match_the_spec_shape(pool: PgPool) {
    let w = world(pool).await;
    fund(&w, 1_000_000).await;
    watcher::tick(&w.state).await.unwrap();
    outbox::deliver_due(&w.state, &reqwest::Client::new())
        .await
        .unwrap();
    let r = &w.orchestrator.received_requests().await.unwrap()[0];
    let e: Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(e["type"], "plan.funded");
    assert_eq!(e["payload"]["tier"], "staked");
    assert_eq!(e["payload"]["amount_usdc_units"], "1000000");
    assert_eq!(
        e["payload"]["plan_id"].as_str().unwrap(),
        plan_id().to_string()
    );
    assert_eq!(
        r.headers.get("Idempotency-Key").unwrap().to_str().unwrap(),
        e["event_id"].as_str().unwrap()
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn outbox_retries_until_orchestrator_answers_200(pool: PgPool) {
    let w = world(pool).await;
    w.orchestrator.reset().await;
    Mock::given(method("POST"))
        .and(path("/v0/chain-events"))
        .respond_with(ResponseTemplate::new(503))
        .up_to_n_times(1)
        .mount(&w.orchestrator)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&w.orchestrator)
        .await;
    fund(&w, 1_000_000).await;
    watcher::tick(&w.state).await.unwrap();
    let http = reqwest::Client::new();
    assert_eq!(
        outbox::deliver_due(&w.state, &http).await.unwrap(),
        0,
        "first attempt fails"
    );
    outbox::make_all_due(&w.state).await.unwrap();
    assert_eq!(
        outbox::deliver_due(&w.state, &http).await.unwrap(),
        1,
        "retry succeeds"
    );
    assert_eq!(w.orchestrator.received_requests().await.unwrap().len(), 2);
}

#[sqlx::test(migrations = "./migrations")]
async fn rejects_event_failing_schema_with_400(pool: PgPool) {
    let w = world(pool).await;
    let mut e = dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a77", 1, 1);
    e["payload"]["amount_usdc_units"] = json!(1000000); // a number, not a decimal string
    assert_eq!(post(&w, &e).await, StatusCode::BAD_REQUEST);
    let unknown = envelope(
        "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a78",
        "task.teleported",
        json!({}),
    );
    assert_eq!(post(&w, &unknown).await, StatusCode::BAD_REQUEST);
    let mut zero_attempt = dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a79", 1, 1);
    zero_attempt["payload"]["attempt"] = json!(0);
    assert_eq!(post(&w, &zero_attempt).await, StatusCode::BAD_REQUEST);
}

#[sqlx::test(migrations = "./migrations")]
async fn reverted_transaction_becomes_an_error_event(pool: PgPool) {
    let w = world(pool).await;
    fund(&w, 1_000_000).await;
    let e = dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7a", 1, 5_000_000); // more than the plan holds
    assert_eq!(post(&w, &e).await, StatusCode::OK);
    outbox::deliver_due(&w.state, &reqwest::Client::new())
        .await
        .unwrap();
    let got: Vec<Value> = w
        .orchestrator
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| serde_json::from_slice(&r.body).unwrap())
        .collect();
    let err = got
        .iter()
        .find(|e| e["type"] == "error")
        .expect("an error event");
    assert_eq!(
        err["payload"]["ref_event_id"],
        "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7a"
    );
    assert_eq!(err["payload"]["code"], "TX_REVERTED");
}

#[sqlx::test(migrations = "./migrations")]
async fn keeper_releases_after_window_and_returns_after_deadline(pool: PgPool) {
    let w = world(pool).await;
    fund(&w, 2_000_000).await;
    post(
        &w,
        &dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b", 1, 1_000_000),
    )
    .await;
    // A second task (index 1) that never commits.
    post(
        &w,
        &dispatch_index(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7c", 1, 1, 1_000_000),
    )
    .await;
    post(
        &w,
        &sealed_event(
            "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7d",
            &sealed_for(&w, task(1)),
        ),
    )
    .await;
    // The validator did not draw an audit for the first task, so it may release when the window ends.
    let v = w.chain.contracts(w.chain.keys.validator.clone());
    v.escrow
        .markNotDrawn(task(1))
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    watcher::tick(&w.state).await.unwrap();
    keeper::tick(&w.state).await.unwrap();
    assert_eq!(task_state(&w, task(1)).await.1, 1, "nothing is due yet");
    w.chain.increase_time(3600).await;
    keeper::tick(&w.state).await.unwrap();
    assert_eq!(
        task_state(&w, task(1)).await.1,
        2,
        "committed, not drawn, window over: released"
    );
    assert_eq!(
        task_state(&w, task_id(plan_id(), 1, 1)).await.1,
        3,
        "never committed, past deadline: returned"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn keeper_does_not_release_a_drawn_audit_that_never_ran(pool: PgPool) {
    let w = world(pool).await;
    fund(&w, 1_000_000).await;
    post(
        &w,
        &dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a98", 1, 1_000_000),
    )
    .await;
    post(
        &w,
        &sealed_event(
            "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a99",
            &sealed_for(&w, task(1)),
        ),
    )
    .await;
    watcher::tick(&w.state).await.unwrap();
    w.chain.increase_time(3600).await;
    keeper::tick(&w.state).await.unwrap();
    assert_eq!(
        task_state(&w, task(1)).await.1,
        1,
        "validator down: the task waits for its audit"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn healthz_is_ok(pool: PgPool) {
    let w = world(pool).await;
    let res = app(w.state.clone())
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[sqlx::test(migrations = "./migrations")]
async fn challenge_events_reach_the_orchestrator(pool: PgPool) {
    use alloy::signers::local::PrivateKeySigner;
    let w = world(pool).await;
    fund(&w, 1_000_000).await;
    post(
        &w,
        &dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a80", 1, 1_000_000),
    )
    .await;
    post(
        &w,
        &sealed_event(
            "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a81",
            &sealed_for(&w, task(1)),
        ),
    )
    .await;
    let challenger = PrivateKeySigner::random();
    w.chain.fund_eth(challenger.address()).await;
    w.chain.mint_usdc(challenger.address(), 10_000_000).await;
    let c = w.chain.contracts(challenger);
    c.usdc
        .approve(w.chain.deployment.challenge_manager, U256::from(10_000_000))
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    c.challenges
        .open(task(1))
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    let adj = w.chain.contracts(w.chain.keys.adjudicator.clone());
    adj.challenges
        .resolve(U256::ZERO, true)
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    watcher::tick(&w.state).await.unwrap();
    outbox::deliver_due(&w.state, &reqwest::Client::new())
        .await
        .unwrap();
    let types = received_types(&w.orchestrator).await;
    let pos = |t: &str| {
        types
            .iter()
            .position(|x| x == t)
            .unwrap_or_else(|| panic!("{t} missing from {types:?}"))
    };
    assert!(pos("challenge.opened") < pos("challenge.resolved"));
    assert!(
        pos("challenge.resolved") < pos("task.returned"),
        "{types:?}"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn keeper_finalizes_stake_after_the_window(pool: PgPool) {
    let w = world(pool).await;
    fund(&w, 1_000_000).await;
    post(
        &w,
        &dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a82", 1, 1_000_000),
    )
    .await;
    post(
        &w,
        &sealed_event(
            "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a83",
            &sealed_for(&w, task(1)),
        ),
    )
    .await;
    let v = w.chain.contracts(w.chain.keys.validator.clone());
    v.escrow
        .recordVerdict(task(1), 1)
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    watcher::tick(&w.state).await.unwrap();
    let operator = w.agent.operator.address();
    assert_eq!(
        v.vault.encumberedOf(operator).call().await.unwrap(),
        U256::from(1_500_000),
        "1.5 x V while the window runs"
    );
    keeper::tick(&w.state).await.unwrap();
    assert_eq!(
        v.vault.encumberedOf(operator).call().await.unwrap(),
        U256::from(1_500_000),
        "not before the window ends"
    );
    w.chain.increase_time(700).await;
    keeper::tick(&w.state).await.unwrap();
    assert_eq!(
        v.vault.encumberedOf(operator).call().await.unwrap(),
        U256::ZERO
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn events_without_the_shared_token_are_refused(pool: PgPool) {
    let w = world(pool).await;
    fund(&w, 1_000_000).await;
    let e = dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a90", 1, 1_000_000);
    assert_eq!(post_with(&w, &e, None).await, StatusCode::UNAUTHORIZED);
    assert_eq!(
        post_with(&w, &e, Some("wrong")).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(task_state(&w, task(1)).await.1, 0, "nothing was locked");
    assert_eq!(post(&w, &e).await, StatusCode::OK);
}

#[sqlx::test(migrations = "./migrations")]
async fn closing_an_unknown_plan_is_a_no_op(pool: PgPool) {
    let w = world(pool).await;
    let close = envelope(
        "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a91",
        "plan.closed",
        json!({"plan_id": plan_id()}),
    );
    assert_eq!(post(&w, &close).await, StatusCode::OK);
    outbox::deliver_due(&w.state, &reqwest::Client::new())
        .await
        .unwrap();
    assert!(
        !received_types(&w.orchestrator)
            .await
            .contains(&"error".to_string())
    );
    fund(&w, 1_000_000).await; // funding afterwards still works: the plan was never closed
    assert_eq!(
        w.state
            .contracts
            .escrow
            .planOf(plan_id())
            .call()
            .await
            .unwrap()
            .available,
        U256::from(1_000_000)
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn retry_waits_for_the_previous_attempt_to_return(pool: PgPool) {
    let w = world(pool).await;
    fund(&w, 1_000_000).await;
    post(
        &w,
        &dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a92", 1, 1_000_000),
    )
    .await;
    post(
        &w,
        &sealed_event(
            "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a93",
            &sealed_for(&w, task(1)),
        ),
    )
    .await;
    let retry = dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a94", 2, 1_000_000);
    assert_eq!(
        post(&w, &retry).await,
        StatusCode::SERVICE_UNAVAILABLE,
        "attempt 1 still holds V"
    );
    let v = w.chain.contracts(w.chain.keys.validator.clone());
    v.escrow
        .recordVerdict(task(1), 2)
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap(); // fail: V returns
    assert_eq!(
        post(&w, &retry).await,
        StatusCode::OK,
        "the same event, delivered again, now locks"
    );
    assert_eq!(task_state(&w, task(2)).await.1, 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn dispatch_with_a_task_id_not_derived_from_plan_index_attempt_is_refused(pool: PgPool) {
    let w = world(pool).await;
    let mut e = dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a95", 1, 1_000_000);
    e["payload"]["task_id"] = json!(alloy::primitives::B256::repeat_byte(9));
    assert_eq!(post(&w, &e).await, StatusCode::BAD_REQUEST);
}

#[sqlx::test(migrations = "./migrations")]
async fn a_newer_event_waits_behind_an_older_one_in_backoff(pool: PgPool) {
    let w = world(pool).await;
    w.orchestrator.reset().await;
    Mock::given(method("POST"))
        .and(path("/v0/chain-events"))
        .respond_with(ResponseTemplate::new(503))
        .up_to_n_times(1)
        .mount(&w.orchestrator)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&w.orchestrator)
        .await;
    fund(&w, 1_000_000).await;
    watcher::tick(&w.state).await.unwrap(); // plan.funded queued
    let http = reqwest::Client::new();
    assert_eq!(
        outbox::deliver_due(&w.state, &http).await.unwrap(),
        0,
        "first try fails, row backs off"
    );
    post(
        &w,
        &dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a96", 1, 1_000_000),
    )
    .await;
    watcher::tick(&w.state).await.unwrap(); // task.escrowed queued behind it, due now
    assert_eq!(
        outbox::deliver_due(&w.state, &http).await.unwrap(),
        0,
        "the newer event must not overtake"
    );
    outbox::make_all_due(&w.state).await.unwrap();
    assert_eq!(outbox::deliver_due(&w.state, &http).await.unwrap(), 2);
    assert_eq!(
        received_types(&w.orchestrator).await,
        vec!["plan.funded", "plan.funded", "task.escrowed"]
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn client_errors_are_not_retried(pool: PgPool) {
    let w = world(pool).await;
    w.orchestrator.reset().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(400))
        .up_to_n_times(1)
        .mount(&w.orchestrator)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&w.orchestrator)
        .await;
    fund(&w, 1_000_000).await;
    post(
        &w,
        &dispatch(&w, "6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a97", 1, 1_000_000),
    )
    .await;
    watcher::tick(&w.state).await.unwrap();
    assert_eq!(
        outbox::deliver_due(&w.state, &reqwest::Client::new())
            .await
            .unwrap(),
        1,
        "the 400 is dropped, the next is delivered"
    );
    assert_eq!(
        received_types(&w.orchestrator).await,
        vec!["plan.funded", "task.escrowed"]
    );
}

async fn commitments(w: &World, query: &str) -> (StatusCode, Value) {
    let res = app(w.state.clone())
        .oneshot(
            Request::get(format!("/v0/commitments{query}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into())),
    )
}

/// A browser cannot scan the chain for receipts (public RPCs allow a few hundred blocks per getLogs), so the
/// gateway lists the ones its watcher has seen. The page still checks each against the chain before trusting it.
#[sqlx::test(migrations = "./migrations")]
async fn committed_receipts_are_listed_newest_first(pool: PgPool) {
    let w = world(pool).await;
    let first = commitments(&w, "").await;
    assert_eq!(first.0, StatusCode::OK, "{first:?}");
    assert_eq!(first.1, json!([]));

    fund(&w, 2_000_000).await;
    // Two tasks of one plan, so both can be live at once.
    let tasks = [task_id(plan_id(), 0, 1), task_id(plan_id(), 1, 1)];
    let mut sealed = Vec::new();
    for (index, t) in tasks.iter().enumerate() {
        let n = 10 + index;
        assert_eq!(
            post(
                &w,
                &dispatch_index(
                    &w,
                    &format!("6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a{n}"),
                    index as u32,
                    1,
                    1_000_000
                )
            )
            .await,
            StatusCode::OK
        );
        let b = sealed_for(&w, *t);
        assert_eq!(
            post(
                &w,
                &sealed_event(&format!("6f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6b{n}"), &b)
            )
            .await,
            StatusCode::OK
        );
        sealed.push(b);
    }
    let head = w.state.contracts.provider.get_block_number().await.unwrap();
    loop {
        watcher::tick(&w.state).await.unwrap();
        let cursor: i64 = sqlx::query_scalar("select block from watcher_cursor where id = 1")
            .fetch_one(&w.state.db)
            .await
            .unwrap();
        if cursor as u64 > head {
            break;
        }
    }
    // Reading the chain twice must not list a receipt twice.
    watcher::tick(&w.state).await.unwrap();

    let (status, list) = commitments(&w, "").await;
    assert_eq!(status, StatusCode::OK);
    let rows = list.as_array().expect("an array");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["task_id"], json!(tasks[1]), "newest first");
    assert_eq!(rows[1]["task_id"], json!(tasks[0]));
    let second = &sealed[1].receipt;
    assert_eq!(rows[0]["root"], json!(second.root));
    assert_eq!(rows[0]["body_hash"], json!(second.body_hash));
    assert_eq!(
        rows[0]["agent_id"],
        json!(second.header.agent_id.to_string())
    );
    assert_eq!(
        rows[0]["cost_micros"],
        json!(second.meter.usd_micros.to_string())
    );
    assert!(rows[0]["block"].as_u64().unwrap() >= rows[1]["block"].as_u64().unwrap());
    assert!(rows[0]["tx"].as_str().unwrap().starts_with("0x"));

    let (_, one) = commitments(&w, "?limit=1").await;
    assert_eq!(one.as_array().unwrap().len(), 1);

    // One task's commitment, for the control plane's cost lookup; a task with none is an empty list.
    let (status, only) = commitments(&w, &format!("?task_id={}", tasks[0])).await;
    assert_eq!(status, StatusCode::OK);
    let only = only.as_array().unwrap();
    assert_eq!(only.len(), 1);
    assert_eq!(only[0]["task_id"], json!(tasks[0]));
    let (_, none) = commitments(&w, &format!("?task_id=0x{}", "0".repeat(64))).await;
    assert_eq!(none, json!([]));
    let (status, refused) = commitments(&w, "?task_id=nonsense").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(refused["error"], json!("BAD_TASK_ID"));
    assert_eq!(one[0]["task_id"], json!(tasks[1]));
    assert_eq!(commitments(&w, "?limit=0").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        commitments(&w, "?limit=banana").await.0,
        StatusCode::BAD_REQUEST
    );
}
