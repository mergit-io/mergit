//! `POST /v0/events`: orchestration → gateway. Idempotent twice over: on `event_id`, and on chain state
//! (a task already locked or a receipt already committed is not sent again).

use crate::events::{
    DispatchRequested, Envelope, Funding, Incoming, PlanApproved, PlanClosed, ReceiptSealed,
};
use crate::outbox;
use crate::tx::TxError;
use crate::{AppState, send_tx};
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

fn reply(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

pub async fn receive(State(s): State<AppState>, body: axum::body::Bytes) -> Response {
    let env: Envelope = match serde_json::from_slice(&body) {
        Ok(e) => e,
        Err(e) => {
            return reply(
                StatusCode::BAD_REQUEST,
                json!({"error": "BAD_ENVELOPE", "message": e.to_string()}),
            );
        }
    };
    let incoming = match Incoming::parse(&env.ty, env.payload) {
        Ok(i) => i,
        Err(m) => {
            return reply(
                StatusCode::BAD_REQUEST,
                json!({"error": "BAD_PAYLOAD", "message": m}),
            );
        }
    };
    match sqlx::query_scalar::<_, bool>(
        "select exists(select 1 from processed_events where event_id = $1)",
    )
    .bind(env.event_id)
    .fetch_one(&s.db)
    .await
    {
        Ok(true) => return reply(StatusCode::OK, json!({"status": "duplicate"})),
        Ok(false) => {}
        Err(e) => {
            return reply(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": "DB", "message": e.to_string()}),
            );
        }
    }

    let result = {
        let _one_at_a_time = s.tx_lock.lock().await;
        match incoming {
            Incoming::PlanApproved(p) => plan_approved(&s, p).await,
            Incoming::DispatchRequested(d) => dispatch(&s, d).await,
            Incoming::ReceiptSealed(r) => sealed(&s, r).await,
            Incoming::PlanClosed(p) => closed(&s, p).await,
            Incoming::CreditsGrant(g) => crate::credits::grant(&s, &g).await,
        }
    };

    match result {
        Ok(()) => {}
        Err(Handled::NotImplemented(m)) => {
            return reply(
                StatusCode::NOT_IMPLEMENTED,
                json!({"error": "NOT_IMPLEMENTED", "message": m}),
            );
        }
        Err(Handled::Tx(TxError::Transient(m))) => {
            return reply(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": "CHAIN_UNAVAILABLE", "message": m}),
            );
        }
        Err(Handled::Tx(TxError::Reverted(m))) => {
            tracing::warn!(event_id = %env.event_id, ty = %env.ty, %m, "transaction reverted");
            let payload =
                json!({"ref_event_id": env.event_id, "code": "TX_REVERTED", "message": m});
            if let Err(e) = outbox::enqueue_orchestrator(&s.db, &s.cfg, "error", payload).await {
                return reply(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"error": "DB", "message": e.to_string()}),
                );
            }
        }
    }
    if let Err(e) =
        sqlx::query("insert into processed_events (event_id) values ($1) on conflict do nothing")
            .bind(env.event_id)
            .execute(&s.db)
            .await
    {
        return reply(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": "DB", "message": e.to_string()}),
        );
    }
    reply(StatusCode::OK, json!({"status": "ok"}))
}

pub enum Handled {
    Tx(TxError),
    NotImplemented(&'static str),
}

impl From<TxError> for Handled {
    fn from(e: TxError) -> Self {
        Handled::Tx(e)
    }
}

fn read(e: alloy::contract::Error) -> Handled {
    Handled::Tx(crate::tx::classify(e))
}

async fn plan_approved(s: &AppState, p: PlanApproved) -> Result<(), Handled> {
    match p.funding {
        // The requester funds from their own wallet; the watcher reports PlanFunded when it lands.
        Funding::Wallet => Ok(()),
        Funding::Credits => crate::credits::fund(s, &p).await,
    }
}

async fn dispatch(s: &AppState, d: DispatchRequested) -> Result<(), Handled> {
    let existing = s
        .contracts
        .escrow
        .taskOf(d.task_id)
        .call()
        .await
        .map_err(read)?;
    if existing.state != 0 {
        return Ok(()); // already locked by an earlier delivery
    }
    if d.attempt > 1 {
        // A retry may only lock once the previous attempt's V is back in the plan; until then, ask the sender to
        // deliver again later rather than locking a second V or failing for good.
        let previous = mergit_spec::task_id(d.plan_id, d.index, d.attempt - 1);
        if s.contracts
            .escrow
            .taskOf(previous)
            .call()
            .await
            .map_err(read)?
            .state
            == 1
        {
            return Err(Handled::Tx(TxError::Transient(format!(
                "attempt {} of this task still holds its payment",
                d.attempt - 1
            ))));
        }
    }
    send_tx!(s.contracts.escrow.lockTask(
        d.task_id,
        d.plan_id,
        d.agent_id,
        d.amount_usdc_units,
        d.deadline_unix,
        d.phi_hash
    ))?;
    Ok(())
}

async fn sealed(s: &AppState, r: ReceiptSealed) -> Result<(), Handled> {
    let c = s
        .contracts
        .registry
        .commitmentOf(r.task_id)
        .call()
        .await
        .map_err(read)?;
    if c.committedAt != 0 {
        return Ok(());
    }
    let cost = alloy::primitives::U256::from(r.cost_micros);
    send_tx!(s.contracts.registry.commit(
        r.task_id,
        r.agent_id,
        r.root,
        r.terminal_hash,
        r.body_hash,
        cost,
        r.signature
    ))?;
    Ok(())
}

async fn closed(s: &AppState, p: PlanClosed) -> Result<(), Handled> {
    let plan = s
        .contracts
        .escrow
        .planOf(p.plan_id)
        .call()
        .await
        .map_err(read)?;
    if plan.closed || plan.requester == alloy::primitives::Address::ZERO {
        return Ok(()); // already closed, or never funded: nothing to close
    }
    send_tx!(s.contracts.escrow.closePlan(p.plan_id))?;
    Ok(())
}
