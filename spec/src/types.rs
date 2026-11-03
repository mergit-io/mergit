use alloy_primitives::{Address, B256, Bytes};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The outcome predicate Φ, kind `exec/0`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Predicate {
    pub kind: String,
    pub command: Vec<String>,
    pub expected_exit: i32,
    pub workdir: String,
    pub allowed_paths: Option<Vec<String>>,
    pub artifact_hashes: Option<BTreeMap<String, B256>>,
    pub timeout_s: u32,
}

/// The output of running Φ; the `phi_eval` step's output bytes are its canonical JSON.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PhiResult {
    pub exit_code: i32,
    pub changed_paths: Vec<String>,
    pub observed_artifact_hashes: BTreeMap<String, B256>,
    pub stdout_digest: B256,
    pub holds: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Attestation {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_key: Option<Address>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_key: Option<Address>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measurement: Option<String>,
}

impl Attestation {
    /// The v0 attestation: no hardware claim, signed by a developer key.
    pub fn unattested(dev_key: Address) -> Self {
        Self {
            kind: crate::UNATTESTED.into(),
            dev_key: Some(dev_key),
            runtime_key: None,
            measurement: None,
        }
    }

    /// An attestation of `kind` claiming a runtime key and a measurement.
    pub fn attested(kind: &str, runtime_key: Address, measurement: &str) -> Self {
        Self {
            kind: kind.into(),
            dev_key: None,
            runtime_key: Some(runtime_key),
            measurement: Some(measurement.into()),
        }
    }

    /// The key the receipt signature must recover to.
    pub fn signing_key(&self) -> Option<Address> {
        self.dev_key.or(self.runtime_key)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub version: String,
    pub task_id: B256,
    pub plan_id: B256,
    pub requester: Address,
    pub agent_id: String,
    pub category: String,
    pub phi: Predicate,
    pub phi_hash: B256,
    pub budget_usdc_units: String,
    pub runtime_image: String,
    pub attestation: Attestation,
    pub started_at: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepType {
    ModelCall,
    ToolCall,
    Command,
    ArtifactWrite,
    PhiEval,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct Cost {
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub tool_calls: u64,
    pub wall_ms: u64,
    pub usd_micros: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct Meter {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub tool_calls: u64,
    pub wall_ms: u64,
    pub usd_micros: u64,
}

impl Meter {
    /// Totals over every step's cost.
    pub fn sum(steps: &[Step]) -> Meter {
        steps.iter().fold(Meter::default(), |m, s| Meter {
            input_tokens: m.input_tokens + s.cost.input_tokens,
            output_tokens: m.output_tokens + s.cost.output_tokens,
            tool_calls: m.tool_calls + s.cost.tool_calls,
            wall_ms: m.wall_ms + s.cost.wall_ms,
            usd_micros: m.usd_micros + s.cost.usd_micros,
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub seq: u32,
    #[serde(rename = "type")]
    pub step_type: StepType,
    pub input_digest: B256,
    pub output_digest: B256,
    pub exit_status: Option<i32>,
    pub cost: Cost,
    pub at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SealedReceipt {
    pub header: Header,
    pub steps: Vec<Step>,
    pub evidence: Vec<u32>,
    pub meter: Meter,
    pub ended_at: String,
    pub root: B256,
    pub terminal_hash: B256,
    pub body_hash: B256,
    pub signature: Bytes,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attestation_document: Option<Bytes>,
}

/// What the receipt store accepts and serves: the receipt and the raw bytes behind its digests (base64).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Bundle {
    pub receipt: SealedReceipt,
    pub blobs: BTreeMap<B256, String>,
}
