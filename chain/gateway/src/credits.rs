//! Free credits: the paper's onboarding tier (§4.5, §10.5). A grant per address, a cap per plan and a number
//! of plans per day, all parameters rather than measurements. Credit plans are funded from the treasury
//! through the same Escrow, as Tier.Onboarding, so they are audited at p = 1 and earn no transferable
//! reputation.

use crate::events::{CreditsGrant, PlanApproved, valid_account};
use crate::ingress::Handled;
use crate::outbox::enqueue_orchestrator;
use crate::tx::TxError;
use crate::{AppState, send_tx};
use alloy::primitives::{Address, U256};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sqlx::Row;

fn db_err(e: sqlx::Error) -> Handled {
    Handled::Tx(TxError::Transient(format!("database: {e}")))
}

/// Funds an approved credits plan from the treasury, or queues `credits.denied`.
pub async fn fund(s: &AppState, p: &PlanApproved) -> Result<(), Handled> {
    let Some(treasury) = &s.treasury else {
        return Err(Handled::NotImplemented(
            "free credits are disabled on this gateway",
        ));
    };
    // The ledger key: the account the control plane named, else the requesting address. The grant, the daily
    // count and the refund all follow this key, so a user who requests from several addresses has one grant.
    let address = p
        .credit_account
        .clone()
        .unwrap_or_else(|| p.requester.to_string().to_lowercase());
    let plan = p.plan_id.to_string();
    let amount: u64 = p.total_budget_usdc_units.try_into().unwrap_or(u64::MAX);

    let mut db = s.db.begin().await.map_err(db_err)?;
    if sqlx::query("select 1 from credit_plans where plan_id = $1")
        .bind(&plan)
        .fetch_optional(&mut *db)
        .await
        .map_err(db_err)?
        .is_some()
    {
        return Ok(()); // this plan was already funded from credits
    }
    sqlx::query(
        "insert into credits (address, granted) values ($1, $2) on conflict (address) do nothing",
    )
    .bind(&address)
    .bind(s.cfg.free_credits_units as i64)
    .execute(&mut *db)
    .await
    .map_err(db_err)?;
    sqlx::query("update credits set plans_today = 0, plans_day = current_date where address = $1 and plans_day < current_date")
        .bind(&address)
        .execute(&mut *db)
        .await
        .map_err(db_err)?;
    let row = sqlx::query("select granted - spent as remaining, plans_today from credits where address = $1 for update")
        .bind(&address)
        .fetch_one(&mut *db)
        .await
        .map_err(db_err)?;
    let (remaining, plans_today): (i64, i32) = (row.get("remaining"), row.get("plans_today"));

    let denial = if amount > s.cfg.credit_plan_cap_units {
        Some("over_value_cap")
    } else if plans_today as u32 >= s.cfg.credit_plans_per_day {
        Some("rate_limited")
    } else if (amount as i64) > remaining {
        Some("no_credits")
    } else {
        None
    };
    if let Some(reason) = denial {
        drop(db);
        enqueue_orchestrator(
            &s.db,
            &s.cfg,
            "credits.denied",
            json!({"plan_id": p.plan_id, "reason": reason}),
        )
        .await
        .map_err(db_err)?;
        return Ok(());
    }

    sqlx::query(
        "update credits set spent = spent + $2, plans_today = plans_today + 1 where address = $1",
    )
    .bind(&address)
    .bind(amount as i64)
    .execute(&mut *db)
    .await
    .map_err(db_err)?;
    sqlx::query("insert into credit_plans (plan_id, address, amount) values ($1, $2, $3)")
        .bind(&plan)
        .bind(&address)
        .bind(amount as i64)
        .execute(&mut *db)
        .await
        .map_err(db_err)?;

    // A plan already funded on chain for this requester from credits means an earlier attempt landed but its
    // answer was lost: record it, do not spend the treasury again.
    let onchain = treasury
        .escrow
        .planOf(p.plan_id)
        .call()
        .await
        .map_err(|e| Handled::Tx(crate::tx::classify(e)))?;
    if onchain.requester != Address::ZERO {
        if onchain.requester == p.requester && onchain.tier == 1 {
            db.commit().await.map_err(db_err)?;
            return Ok(());
        }
        return Err(Handled::Tx(TxError::Reverted(
            "plan already funded by someone else or from a wallet".into(),
        )));
    }

    // The ledger commits only if the treasury transaction lands; otherwise nothing was spent.
    let escrow = s.deployment.escrow;
    let treasury_addr = s.deployment.roles.treasury;
    let allowance = treasury
        .usdc
        .allowance(treasury_addr, escrow)
        .call()
        .await
        .map_err(|e| Handled::Tx(crate::tx::classify(e)))?;
    if allowance < U256::from(amount) {
        send_tx!(treasury.usdc.approve(escrow, U256::MAX))?;
    }
    send_tx!(
        treasury
            .escrow
            .fundPlanFor(p.plan_id, p.requester, U256::from(amount))
    )?;
    db.commit().await.map_err(db_err)?;
    Ok(())
}

/// Called by the watcher when a plan closes: a credits plan's refund goes back to its address's credits.
pub async fn restore(db: &mut sqlx::PgConnection, plan_id: &str, refund: u64) -> sqlx::Result<()> {
    if refund == 0 {
        return Ok(());
    }
    sqlx::query(
        "update credits set spent = greatest(spent - $2, 0)
         where address = (select address from credit_plans where plan_id = $1)",
    )
    .bind(plan_id)
    .bind(refund as i64)
    .execute(db)
    .await
    .map(|_| ())
}

/// A ledger's numbers by key. A key that has never used credits sees the grant it would receive.
async fn view(s: &AppState, key: &str) -> Response {
    let row = sqlx::query(
        "select granted, spent, case when plans_day < current_date then 0 else plans_today end as plans_today
         from credits where address = $1",
    )
    .bind(key)
    .fetch_optional(&s.db)
    .await;
    let (granted, spent, plans_today) = match row {
        Ok(Some(r)) => (
            r.get::<i64, _>("granted"),
            r.get::<i64, _>("spent"),
            r.get::<i32, _>("plans_today"),
        ),
        Ok(None) => (s.cfg.free_credits_units as i64, 0, 0),
        Err(e) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "DB", "message": e.to_string()})),
            )
                .into_response();
        }
    };
    Json(json!({
        "granted_usdc_units": granted.to_string(),
        "spent_usdc_units": spent.to_string(),
        "remaining_usdc_units": (granted - spent).max(0).to_string(),
        "plans_today": plans_today,
    }))
    .into_response()
}

/// `GET /v0/credits/{address}`.
pub async fn read(State(s): State<AppState>, Path(address): Path<String>) -> Response {
    let Ok(addr) = address.parse::<Address>() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "BAD_ADDRESS"})),
        )
            .into_response();
    };
    view(&s, &addr.to_string().to_lowercase()).await
}

/// `GET /v0/credits/account/{account}`: the same numbers for a control-plane account.
pub async fn read_account(State(s): State<AppState>, Path(account): Path<String>) -> Response {
    if !valid_account(&account) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "BAD_ACCOUNT"})),
        )
            .into_response();
    }
    view(&s, &account).await
}

/// Adds a redeemed code's amount to an account, once per `ref`. The account's default grant is created first
/// if it does not exist yet, so a code stacks on the free credits instead of replacing them.
pub async fn grant(s: &AppState, g: &CreditsGrant) -> Result<(), Handled> {
    if s.treasury.is_none() {
        return Err(Handled::NotImplemented(
            "free credits are disabled on this gateway",
        ));
    }
    let mut db = s.db.begin().await.map_err(db_err)?;
    let fresh = sqlx::query(
        "insert into credit_grants (ref, account, amount) values ($1, $2, $3) on conflict (ref) do nothing",
    )
    .bind(&g.reference)
    .bind(&g.account)
    .bind(g.amount as i64)
    .execute(&mut *db)
    .await
    .map_err(db_err)?
    .rows_affected();
    if fresh == 0 {
        return Ok(()); // this code was already credited
    }
    sqlx::query(
        "insert into credits (address, granted) values ($1, $2) on conflict (address) do nothing",
    )
    .bind(&g.account)
    .bind(s.cfg.free_credits_units as i64)
    .execute(&mut *db)
    .await
    .map_err(db_err)?;
    sqlx::query("update credits set granted = granted + $2 where address = $1")
        .bind(&g.account)
        .bind(g.amount as i64)
        .execute(&mut *db)
        .await
        .map_err(db_err)?;
    db.commit().await.map_err(db_err)?;
    Ok(())
}
