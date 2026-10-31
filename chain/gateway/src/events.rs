//! Event payloads from `spec/events-v0.md`. Parsing is strict: unknown fields, numbers where decimal
//! strings belong, and malformed hashes are all rejected, which is the schema check for incoming events.

use alloy::primitives::{Address, B256, Bytes, U256};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub event_id: Uuid,
    #[serde(rename = "type")]
    pub ty: String,
    pub at: String,
    pub payload: Value,
}

/// A decimal string, as amounts and ids travel in the spec.
fn decimal<'de, D: Deserializer<'de>>(d: D) -> Result<U256, D::Error> {
    let s = String::deserialize(d)?;
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0'))
    {
        return Err(serde::de::Error::custom("expected a decimal string"));
    }
    U256::from_str_radix(&s, 10).map_err(serde::de::Error::custom)
}

/// An account id or a grant reference: 1 to `max` characters of letters, digits and `_ . : -`. It becomes a database
/// key and part of a URL, so nothing else gets through.
fn token(s: String, what: &str, max: usize) -> Result<String, String> {
    let ok = !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'));
    if ok {
        Ok(s)
    } else {
        Err(format!(
            "{what} must be 1 to {max} characters of letters, digits and _ . : -"
        ))
    }
}

pub fn valid_account(s: &str) -> bool {
    token(s.to_string(), "account", 64).is_ok()
}

fn account<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    token(String::deserialize(d)?, "account", 64).map_err(serde::de::Error::custom)
}

fn optional_account<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)?
        .map(|s| token(s, "credit_account", 64))
        .transpose()
        .map_err(serde::de::Error::custom)
}

fn reference<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    token(String::deserialize(d)?, "ref", 100).map_err(serde::de::Error::custom)
}

/// A positive amount no larger than one million USDC (10^12 base units), so it always fits the ledger's bigint.
fn grant_amount<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let v = decimal(d)?;
    match u64::try_from(v) {
        Ok(n) if n > 0 && n <= 1_000_000_000_000 => Ok(n),
        _ => Err(serde::de::Error::custom(
            "amount must be between 1 and 10^12 base units",
        )),
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Funding {
    Wallet,
    Credits,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanApproved {
    pub plan_id: B256,
    pub plan_uuid: Uuid,
    pub requester: Address,
    #[serde(deserialize_with = "decimal")]
    pub total_budget_usdc_units: U256,
    pub funding: Funding,
    /// The control plane's user id. When present the free credits are that account's, whatever address requests.
    #[serde(default, deserialize_with = "optional_account")]
    pub credit_account: Option<String>,
}

/// Adds credit to an account (a redeemed code). Idempotent on `ref`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreditsGrant {
    #[serde(deserialize_with = "account")]
    pub account: String,
    #[serde(rename = "amount_usdc_units", deserialize_with = "grant_amount")]
    pub amount: u64,
    #[serde(rename = "ref", deserialize_with = "reference")]
    pub reference: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DispatchRequested {
    pub task_id: B256,
    pub plan_id: B256,
    pub index: u32,
    pub attempt: u32,
    #[serde(deserialize_with = "decimal")]
    pub agent_id: U256,
    #[serde(deserialize_with = "decimal")]
    pub amount_usdc_units: U256,
    pub category: String,
    pub phi_hash: B256,
    pub deadline_unix: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptSealed {
    pub task_id: B256,
    #[serde(deserialize_with = "decimal")]
    pub agent_id: U256,
    pub root: B256,
    pub terminal_hash: B256,
    pub body_hash: B256,
    pub cost_micros: u64,
    pub signature: Bytes,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanClosed {
    pub plan_id: B256,
}

/// Every incoming event the gateway understands.
#[derive(Debug)]
pub enum Incoming {
    PlanApproved(PlanApproved),
    DispatchRequested(DispatchRequested),
    ReceiptSealed(ReceiptSealed),
    PlanClosed(PlanClosed),
    CreditsGrant(CreditsGrant),
}

impl Incoming {
    pub fn parse(ty: &str, payload: Value) -> Result<Self, String> {
        let e = |err: serde_json::Error| format!("{ty}: {err}");
        Ok(match ty {
            "plan.approved" => Self::PlanApproved(serde_json::from_value(payload).map_err(e)?),
            "task.dispatch_requested" => {
                let d: DispatchRequested = serde_json::from_value(payload).map_err(e)?;
                if d.attempt == 0 {
                    return Err("task.dispatch_requested: attempt starts at 1".into());
                }
                if d.task_id != mergit_spec::task_id(d.plan_id, d.index, d.attempt) {
                    return Err(
                        "task.dispatch_requested: task_id is not keccak(plan_id, index, attempt)"
                            .into(),
                    );
                }
                Self::DispatchRequested(d)
            }
            "receipt.sealed" => Self::ReceiptSealed(serde_json::from_value(payload).map_err(e)?),
            "plan.closed" => Self::PlanClosed(serde_json::from_value(payload).map_err(e)?),
            "credits.grant" => Self::CreditsGrant(serde_json::from_value(payload).map_err(e)?),
            other => return Err(format!("unknown event type {other:?}")),
        })
    }
}
