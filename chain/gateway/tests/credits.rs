//! Free credits (the onboarding tier): granted once per address, capped per plan and per day, funded from the
//! treasury through the same Escrow, and restored when a credits plan closes with money unspent.

mod common;

use alloy::primitives::{Address, B256, U256};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::*;
use http_body_util::BodyExt;
use mergit_gateway::{app, outbox, watcher};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

fn plan(n: u8) -> (B256, String) {
    let uuid = format!("3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a{n:02x}");
    (mergit_spec::plan_id(&uuid), uuid)
}

fn approved(w: &World, n: u8, amount: u64) -> Value {
    let (id, uuid) = plan(n);
    envelope(
        &format!("7f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a{n:02x}"),
        "plan.approved",
        json!({
            "plan_id": id, "plan_uuid": uuid, "requester": w.requester.address(),
            "total_budget_usdc_units": amount.to_string(), "funding": "credits"
        }),
    )
}

async fn credits(w: &World, who: Address) -> Value {
    let res = app(w.state.clone())
        .oneshot(
            Request::get(format!("/v0/credits/{who}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn denied_reasons(w: &World) -> Vec<String> {
    outbox::deliver_due(&w.state, &reqwest::Client::new())
        .await
        .unwrap();
    w.orchestrator
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| serde_json::from_slice::<Value>(&r.body).unwrap())
        .filter(|e| e["type"] == "credits.denied")
        .map(|e| e["payload"]["reason"].as_str().unwrap().to_string())
        .collect()
}

#[sqlx::test(migrations = "./migrations")]
async fn grants_once_per_address(pool: PgPool) {
    let w = world(pool).await;
    assert_eq!(
        credits(&w, w.requester.address()).await["remaining_usdc_units"],
        "5000000"
    );
    assert_eq!(post(&w, &approved(&w, 1, 2_000_000)).await, StatusCode::OK);
    let c = credits(&w, w.requester.address()).await;
    assert_eq!(c["granted_usdc_units"], "5000000");
    assert_eq!(c["spent_usdc_units"], "2000000");
    assert_eq!(c["remaining_usdc_units"], "3000000");
    assert_eq!(c["plans_today"], 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn credits_fund_plan_as_onboarding_tier(pool: PgPool) {
    let w = world(pool).await;
    post(&w, &approved(&w, 2, 1_500_000)).await;
    let p = w
        .state
        .contracts
        .escrow
        .planOf(plan(2).0)
        .call()
        .await
        .unwrap();
    assert_eq!(p.requester, w.requester.address());
    assert_eq!(p.tier, 1, "onboarding");
    assert_eq!(p.available, U256::from(1_500_000));
}

#[sqlx::test(migrations = "./migrations")]
async fn denies_over_plan_cap(pool: PgPool) {
    let w = world(pool).await;
    assert_eq!(post(&w, &approved(&w, 3, 2_000_001)).await, StatusCode::OK);
    assert_eq!(denied_reasons(&w).await, vec!["over_value_cap"]);
    assert_eq!(
        w.state
            .contracts
            .escrow
            .planOf(plan(3).0)
            .call()
            .await
            .unwrap()
            .requester,
        Address::ZERO,
        "not funded"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn denies_over_remaining(pool: PgPool) {
    let w = world(pool).await;
    post(&w, &approved(&w, 4, 2_000_000)).await;
    post(&w, &approved(&w, 5, 2_000_000)).await;
    post(&w, &approved(&w, 6, 2_000_000)).await; // only 1 USDC left
    assert_eq!(denied_reasons(&w).await, vec!["no_credits"]);
    assert_eq!(
        credits(&w, w.requester.address()).await["remaining_usdc_units"],
        "1000000"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn rate_limits_per_day(pool: PgPool) {
    let w = world_with(pool, |c| c.credit_plans_per_day = 2).await;
    for n in 7..10 {
        post(&w, &approved(&w, n, 500_000)).await;
    }
    assert_eq!(denied_reasons(&w).await, vec!["rate_limited"]);
    assert_eq!(credits(&w, w.requester.address()).await["plans_today"], 2);
}

#[sqlx::test(migrations = "./migrations")]
async fn refund_on_close_restores_credits(pool: PgPool) {
    let w = world(pool).await;
    post(&w, &approved(&w, 10, 2_000_000)).await;
    assert_eq!(
        credits(&w, w.requester.address()).await["remaining_usdc_units"],
        "3000000"
    );
    let close = envelope(
        "8f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a10",
        "plan.closed",
        json!({"plan_id": plan(10).0}),
    );
    assert_eq!(post(&w, &close).await, StatusCode::OK);
    watcher::tick(&w.state).await.unwrap();
    assert_eq!(
        credits(&w, w.requester.address()).await["remaining_usdc_units"],
        "5000000"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn a_plan_already_funded_on_chain_is_not_funded_again(pool: PgPool) {
    // The treasury transaction mined but the gateway lost the answer (restart, receipt timeout): the retry must
    // not spend the treasury twice.
    let w = world(pool).await;
    let t = w.chain.contracts(w.chain.keys.treasury.clone());
    t.usdc
        .approve(w.chain.deployment.escrow, U256::from(1_000_000))
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    t.escrow
        .fundPlanFor(plan(12).0, w.requester.address(), U256::from(1_000_000))
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    let before = t
        .usdc
        .balanceOf(w.chain.keys.treasury.address())
        .call()
        .await
        .unwrap();
    assert_eq!(post(&w, &approved(&w, 12, 1_000_000)).await, StatusCode::OK);
    assert_eq!(
        t.usdc
            .balanceOf(w.chain.keys.treasury.address())
            .call()
            .await
            .unwrap(),
        before
    );
    assert_eq!(
        w.state
            .contracts
            .escrow
            .planOf(plan(12).0)
            .call()
            .await
            .unwrap()
            .available,
        U256::from(1_000_000)
    );
    assert_eq!(
        credits(&w, w.requester.address()).await["spent_usdc_units"],
        "1000000",
        "the ledger catches up"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn the_same_approval_twice_spends_once(pool: PgPool) {
    let w = world(pool).await;
    let e = approved(&w, 11, 1_000_000);
    post(&w, &e).await;
    post(&w, &e).await;
    assert_eq!(
        credits(&w, w.requester.address()).await["spent_usdc_units"],
        "1000000"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn credits_are_readable_from_the_web_app_origin(pool: PgPool) {
    let w = world(pool).await;
    let req = Request::get(format!("/v0/credits/{}", w.requester.address()))
        .header("origin", "https://app.mergit.site")
        .body(Body::empty())
        .unwrap();
    let res = app(w.state.clone()).oneshot(req).await.unwrap();
    assert_eq!(
        res.headers().get("access-control-allow-origin").unwrap(),
        "*"
    );
}

// -- per-account ledger and redeem-code grants -------------------------------------------------------------------

fn approved_for(n: u8, amount: u64, requester: Address, account: Option<&str>) -> Value {
    let (id, uuid) = plan(n);
    let mut payload = json!({
        "plan_id": id, "plan_uuid": uuid, "requester": requester,
        "total_budget_usdc_units": amount.to_string(), "funding": "credits"
    });
    if let Some(a) = account {
        payload["credit_account"] = json!(a);
    }
    envelope(
        &format!("7f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a{n:02x}"),
        "plan.approved",
        payload,
    )
}

fn grant(n: u8, account: &str, amount: u64, reference: &str) -> Value {
    envelope(
        &format!("9f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a{n:02x}"),
        "credits.grant",
        json!({"account": account, "amount_usdc_units": amount.to_string(), "ref": reference}),
    )
}

async fn credits_of_account(w: &World, account: &str) -> Value {
    let res = app(w.state.clone())
        .oneshot(
            Request::get(format!("/v0/credits/account/{account}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[sqlx::test(migrations = "./migrations")]
async fn one_account_shares_one_grant_across_requester_addresses(pool: PgPool) {
    let w = world(pool).await;
    let (a, b) = (Address::with_last_byte(0xa1), Address::with_last_byte(0xb2));
    post(&w, &approved_for(20, 2_000_000, a, Some("user-1"))).await;
    post(&w, &approved_for(21, 2_000_000, b, Some("user-1"))).await;
    assert_eq!(
        credits_of_account(&w, "user-1").await["remaining_usdc_units"],
        "1000000",
        "a second address does not get a second grant"
    );
    post(&w, &approved_for(22, 2_000_000, b, Some("user-1"))).await;
    assert_eq!(denied_reasons(&w).await, vec!["no_credits"]);
    assert_eq!(
        credits_of_account(&w, "user-2").await["remaining_usdc_units"],
        "5000000",
        "another account has its own grant"
    );
    assert_eq!(
        credits(&w, a).await["remaining_usdc_units"],
        "5000000",
        "the address-keyed ledger is untouched"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn a_grant_adds_to_the_account_once_per_ref(pool: PgPool) {
    let w = world(pool).await;
    assert_eq!(
        post(&w, &grant(30, "user-1", 20_000_000, "code-1")).await,
        StatusCode::OK
    );
    let c = credits_of_account(&w, "user-1").await;
    assert_eq!(
        c["granted_usdc_units"], "25000000",
        "the free 5 plus the code"
    );
    assert_eq!(c["remaining_usdc_units"], "25000000");
    // The same ref under a new event id (a redelivery, a replay) adds nothing.
    post(&w, &grant(31, "user-1", 20_000_000, "code-1")).await;
    assert_eq!(
        credits_of_account(&w, "user-1").await["granted_usdc_units"],
        "25000000"
    );
    post(&w, &grant(32, "user-1", 1_000_000, "code-2")).await;
    assert_eq!(
        credits_of_account(&w, "user-1").await["granted_usdc_units"],
        "26000000"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn granted_credits_fund_plans_beyond_the_free_five(pool: PgPool) {
    let w = world(pool).await;
    let a = Address::with_last_byte(0xa1);
    post(&w, &grant(33, "user-1", 20_000_000, "code-1")).await;
    for n in 23..26 {
        post(&w, &approved_for(n, 2_000_000, a, Some("user-1"))).await; // 6 USDC, more than the free 5
    }
    assert!(denied_reasons(&w).await.is_empty());
    assert_eq!(
        credits_of_account(&w, "user-1").await["remaining_usdc_units"],
        "19000000"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn a_refund_on_close_goes_back_to_the_account(pool: PgPool) {
    let w = world(pool).await;
    let a = Address::with_last_byte(0xa1);
    post(&w, &approved_for(26, 2_000_000, a, Some("user-9"))).await;
    assert_eq!(
        credits_of_account(&w, "user-9").await["remaining_usdc_units"],
        "3000000"
    );
    let close = envelope(
        "8f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a26",
        "plan.closed",
        json!({"plan_id": plan(26).0}),
    );
    post(&w, &close).await;
    watcher::tick(&w.state).await.unwrap();
    assert_eq!(
        credits_of_account(&w, "user-9").await["remaining_usdc_units"],
        "5000000"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn a_malformed_grant_or_account_is_refused(pool: PgPool) {
    let w = world(pool).await;
    let bad = |n: u8, payload: Value| {
        envelope(
            &format!("9f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6b{n:02x}"),
            "credits.grant",
            payload,
        )
    };
    let cases = [
        bad(
            1,
            json!({"account": "u", "amount_usdc_units": 20000000, "ref": "r"}),
        ), // a number
        bad(
            2,
            json!({"account": "u", "amount_usdc_units": "0", "ref": "r"}),
        ),
        bad(
            3,
            json!({"account": "", "amount_usdc_units": "1", "ref": "r"}),
        ),
        bad(
            4,
            json!({"account": "a b", "amount_usdc_units": "1", "ref": "r"}),
        ),
        bad(
            5,
            json!({"account": "u/../x", "amount_usdc_units": "1", "ref": "r"}),
        ),
        bad(
            6,
            json!({"account": "u", "amount_usdc_units": "1", "ref": ""}),
        ),
        bad(
            7,
            json!({"account": "u", "amount_usdc_units": "1", "ref": "r", "extra": 1}),
        ),
        bad(
            8,
            json!({"account": "u", "amount_usdc_units": "99999999999999999999", "ref": "r"}),
        ),
        bad(
            9,
            json!({"account": "x".repeat(65), "amount_usdc_units": "1", "ref": "r"}),
        ),
    ];
    for c in &cases {
        assert_eq!(post(&w, c).await, StatusCode::BAD_REQUEST, "{c}");
    }
    let bad_account = approved_for(
        27,
        1_000_000,
        Address::with_last_byte(1),
        Some("not valid!"),
    );
    assert_eq!(post(&w, &bad_account).await, StatusCode::BAD_REQUEST);
    // Positive controls: the strictness above is the validator's, not an unknown event type.
    assert_eq!(
        post(&w, &grant(40, "user-1", 20_000_000, "code-ok")).await,
        StatusCode::OK
    );
    let ok = approved_for(28, 1_000_000, Address::with_last_byte(1), Some("user-1"));
    assert_eq!(post(&w, &ok).await, StatusCode::OK);
}
