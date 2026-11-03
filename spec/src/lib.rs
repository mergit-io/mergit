//! Types and hashing for Mergit receipt format v0 (`spec/receipt-v0.md`, `spec/predicate-v0.md`).
//!
//! Both the receipt builder and the verifier depend on this crate, so the verifier never needs the runtime.

mod eip712;
mod hash;
mod ids;
mod merkle;
mod phi;
mod types;

pub use eip712::{Receipt, receipt_domain};
pub use hash::{body_hash, chain, fmt_time, jcs_bytes, jcs_hash, leaf};
pub use ids::{plan_id, task_id};
pub use merkle::{merkle_proof, merkle_root, verify_proof};
pub use phi::phi_holds;
pub use types::*;

/// The only receipt version this crate reads and writes.
pub const VERSION: &str = "mergit-receipt/0";
/// Receipt format v1: open attestation kinds and an optional attestation document.
pub const VERSION_V1: &str = "mergit-receipt/1";
/// The only attestation kind in v0.
pub const UNATTESTED: &str = "unattested";
/// The only predicate kind in v0.
pub const PREDICATE_KIND: &str = "exec/0";
