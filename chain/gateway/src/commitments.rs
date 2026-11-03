//! `GET /v0/commitments`: the receipts the watcher has seen committed, newest first. See migrations/0004.
//! `?task_id=0x…` lists only that task's commitment (the control plane reads a finished task's metered cost
//! this way, so it never has to page through everything).

use crate::AppState;
use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 1000;

#[derive(Deserialize)]
pub struct Params {
    limit: Option<String>,
    task_id: Option<String>,
}

fn bad(error: &str, message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error": error, "message": message})),
    )
        .into_response()
}

/// `0x` and 64 lower-case hex digits, the form every task id is stored in.
fn is_task_id(text: &str) -> bool {
    text.len() == 66
        && text.starts_with("0x")
        && text[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub async fn list(State(s): State<AppState>, Query(q): Query<Params>) -> Response {
    let limit = match q.limit.as_deref() {
        None => DEFAULT_LIMIT,
        Some(text) => match text.parse::<i64>() {
            Ok(n) if n >= 1 => n.min(MAX_LIMIT),
            _ => return bad("BAD_LIMIT", "limit is a whole number of at least 1"),
        },
    };
    if let Some(task_id) = q.task_id.as_deref()
        && !is_task_id(task_id)
    {
        return bad("BAD_TASK_ID", "task_id is 0x and 64 lower-case hex digits");
    }
    let rows = sqlx::query(
        "select task_id, agent_id, root, body_hash, cost_micros, block, tx from commitments
         where ($2::text is null or task_id = $2)
         order by block desc, log_index desc limit $1",
    )
    .bind(limit)
    .bind(q.task_id.as_deref())
    .fetch_all(&s.db)
    .await;
    match rows {
        Ok(rows) => Json(
            rows.iter()
                .map(|r| {
                    json!({
                        "task_id": r.get::<String, _>("task_id"),
                        "agent_id": r.get::<String, _>("agent_id"),
                        "root": r.get::<String, _>("root"),
                        "body_hash": r.get::<String, _>("body_hash"),
                        // Strings, like every amount here: a JavaScript number cannot hold every value safely.
                        "cost_micros": r.get::<i64, _>("cost_micros").to_string(),
                        "block": r.get::<i64, _>("block"),
                        "tx": r.get::<String, _>("tx"),
                    })
                })
                .collect::<Vec<Value>>(),
        )
        .into_response(),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "DB", "message": e.to_string()})),
        )
            .into_response(),
    }
}
