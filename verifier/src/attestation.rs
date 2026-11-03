//! Attestation documents and the trust policy they are checked against.
//!
//! A per-kind [`AttestationVerifier`] turns a vendor document into [`Claims`]; the verifier core then compares
//! those claims with the receipt header and the [`TrustPolicy`]. The policy is an explicit input: the default
//! is empty and trusts nothing, so an attested receipt can never be `valid` without one.

use alloy_primitives::Address;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;

/// What a verified document attests: the measured runtime image and the key that runtime holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claims {
    pub measurement: String,
    pub bound_key: Address,
}

/// Why a document did not verify. Every variant is reported as `ATTESTATION_INVALID`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocError {
    /// The bytes do not parse as a document of this kind.
    Malformed,
    /// The document parses but does not chain to any of the policy's roots.
    Untrusted,
    /// A certificate in the chain is outside its validity window at `now`.
    Expired,
}

/// Checks documents of one attestation kind against the vendor's root of trust.
pub trait AttestationVerifier: Send + Sync {
    /// The header `attestation.kind` this verifier handles.
    fn kind(&self) -> &'static str;
    /// Verifies `document` against `roots` (the policy's certificates for this kind) at `now` (unix seconds),
    /// returning the attested claims. Must not panic on any input.
    fn verify_document(
        &self,
        document: &[u8],
        roots: &[Vec<u8>],
        now: i64,
    ) -> Result<Claims, DocError>;
}

/// What is trusted for one kind: vendor roots (DER certificates) and the accepted measurements (hex).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KindPolicy {
    pub roots: Vec<Vec<u8>>,
    pub measurements: Vec<String>,
}

impl KindPolicy {
    /// Whether `measurement` is in the allowlist, compared as normalised hex.
    pub fn allows(&self, measurement: &str) -> bool {
        normalise_measurement(measurement).is_some_and(|m| {
            self.measurements
                .iter()
                .any(|a| normalise_measurement(a).as_ref() == Some(&m))
        })
    }
}

/// Per-kind trust. JSON: `{ "<kind>": { "roots": [<base64 DER>], "measurements": [<hex>] } }`.
/// The default is empty: nothing is trusted, so no attested receipt can be `valid`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TrustPolicy(pub BTreeMap<String, KindPolicy>);

/// `measurement` as lowercase hex without a `0x` prefix; `None` unless it is non-empty hex.
/// Case and the prefix never change the outcome; anything that is not hex never matches.
pub fn normalise_measurement(measurement: &str) -> Option<String> {
    let lower = measurement.to_ascii_lowercase();
    let hex = lower.strip_prefix("0x").unwrap_or(&lower);
    (!hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| hex.to_string())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct KindPolicyJson {
    roots: Vec<String>,
    measurements: Vec<String>,
}

impl Serialize for KindPolicy {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        KindPolicyJson {
            roots: self.roots.iter().map(|r| STANDARD.encode(r)).collect(),
            measurements: self.measurements.clone(),
        }
        .serialize(s)
    }
}

impl<'de> Deserialize<'de> for KindPolicy {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = KindPolicyJson::deserialize(d)?;
        let roots = raw
            .roots
            .iter()
            .map(|r| STANDARD.decode(r))
            .collect::<Result<_, _>>()
            .map_err(|e| serde::de::Error::custom(format!("policy root is not base64: {e}")))?;
        Ok(KindPolicy {
            roots,
            measurements: raw.measurements,
        })
    }
}
