use crate::types::{SealedReceipt, Step};
use alloy_primitives::{B256, keccak256};
use serde::Serialize;

/// RFC 8785 canonical JSON bytes.
pub fn jcs_bytes<T: Serialize + ?Sized>(v: &T) -> Vec<u8> {
    serde_jcs::to_vec(v).expect("receipt types always serialise")
}

/// `H(x) = keccak256(JCS(x))`.
pub fn jcs_hash<T: Serialize + ?Sized>(v: &T) -> B256 {
    keccak256(jcs_bytes(v))
}

/// `leaf_i = H(step_i)`.
pub fn leaf(step: &Step) -> B256 {
    jcs_hash(step)
}

/// `h_i = keccak256(h_{i-1} ‖ leaf_i)`, starting from `h_0`; returns `h_n`.
pub fn chain(h0: B256, leaves: &[B256]) -> B256 {
    leaves
        .iter()
        .fold(h0, |h, l| keccak256([h.as_slice(), l.as_slice()].concat()))
}

/// `H(receipt without body_hash and signature)`.
pub fn body_hash(r: &SealedReceipt) -> B256 {
    let mut v = serde_json::to_value(r).expect("receipt types always serialise");
    let o = v.as_object_mut().expect("a receipt is an object");
    o.remove("body_hash");
    o.remove("signature");
    o.remove("attestation_document");
    jcs_hash(&v)
}

/// RFC 3339, UTC, milliseconds, `Z`.
pub fn fmt_time(t: chrono::DateTime<chrono::Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}
