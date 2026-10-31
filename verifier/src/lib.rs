//! Verifies Mergit receipts (formats v0 and v1) without trusting, or depending on, the runtime that built them.
//!
//! Every check runs and every failing reason is reported. `valid` needs a v1 receipt whose attestation
//! document verifies against the [`TrustPolicy`]'s roots for its kind, attests to the header's measurement
//! (which the policy allows) and binds the key that signed. A receipt without a verified document is
//! `unattested_valid` at best; one that claims an attested kind but fails any of that is `invalid`.

mod attestation;
#[cfg(feature = "test-attestation")]
pub mod test_kind;

pub use attestation::{
    AttestationVerifier, Claims, DocError, KindPolicy, TrustPolicy, normalise_measurement,
};

use alloy_primitives::{Address, B256, Signature, U256, keccak256};
use alloy_sol_types::{Eip712Domain, SolStruct};
use base64::{Engine, engine::general_purpose::STANDARD};
use mergit_spec::*;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// What the chain holds for a task, for comparison with the receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commitment {
    pub root: B256,
    pub terminal_hash: B256,
    pub body_hash: B256,
    pub cost_micros: U256,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Every check passed and the attestation verified against the trust policy.
    Valid,
    /// Every check passed; the receipt carries no hardware attestation.
    UnattestedValid,
    Invalid,
}

/// Reason codes from `spec/receipt-v0.md` and `spec/receipt-v1.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Reason {
    SeqGap,
    SeqOrder,
    ChainMismatch,
    RootMismatch,
    BodyHashMismatch,
    BadSignature,
    PhiHashMismatch,
    NoPhiEval,
    PhiEvalNotLast,
    PhiEvalNotEvidence,
    MeterMismatch,
    BlobMissing,
    BlobDigestMismatch,
    PhiResultContradicted,
    CommitmentMismatch,
    AttestationUnsupported,
    /// An attested kind whose document is absent or does not verify against the policy's roots at `now`.
    AttestationInvalid,
    /// The document's measurement differs from the header's, or the policy does not allow it.
    AttestationMeasurement,
    /// The document's key differs from the header's `runtime_key`, or the signature does not recover to it.
    AttestationKeyMismatch,
    Unattested,
}

impl Reason {
    /// Whether this reason is information only. Every other reason makes a receipt invalid. This is the one
    /// place that classification lives, so the validator and clients cannot disagree about it.
    pub fn is_informational(self) -> bool {
        matches!(self, Reason::Unattested)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub status: Status,
    pub reasons: Vec<Reason>,
    /// Whether Φ holds, recomputed from the recorded result; `None` when the result could not be read.
    pub phi_holds: Option<bool>,
}

/// Checks a bundle with an empty trust policy, so nothing is attested: the result is `unattested_valid` or
/// `invalid`, never `valid`. `expected_signer` is the agent's registered runtime key when known; the
/// signature must also recover to the header's signing key. `commitment` is what the chain holds, when known.
pub fn verify(
    bundle: &Bundle,
    domain: &Eip712Domain,
    expected_signer: Option<Address>,
    commitment: Option<&Commitment>,
) -> Report {
    Verifier::new(TrustPolicy::default()).verify(bundle, domain, expected_signer, commitment, 0)
}

/// A receipt verifier: a trust policy plus the attestation kinds it can check.
pub struct Verifier {
    policy: TrustPolicy,
    verifiers: BTreeMap<&'static str, Box<dyn AttestationVerifier>>,
}

/// Attestation kinds compiled in. None in a default build; `test-ed25519` only with the `test-attestation`
/// feature, which no release package enables.
fn builtins() -> Vec<Box<dyn AttestationVerifier>> {
    #[cfg(feature = "test-attestation")]
    return vec![Box::new(test_kind::TestKind)];
    #[cfg(not(feature = "test-attestation"))]
    Vec::new()
}

impl Verifier {
    /// A verifier that trusts exactly `policy`, with the built-in attestation kinds registered.
    pub fn new(policy: TrustPolicy) -> Self {
        let mut v = Self {
            policy,
            verifiers: BTreeMap::new(),
        };
        for b in builtins() {
            v.register(b);
        }
        v
    }

    /// Adds a document checker for its kind, replacing any earlier one for the same kind. A checker for
    /// `unattested` is never consulted.
    pub fn register(&mut self, v: Box<dyn AttestationVerifier>) {
        self.verifiers.insert(v.kind(), v);
    }

    /// Checks a bundle. `expected_signer` is the agent's registered runtime key when known; the signature
    /// must also recover to the header's signing key. `commitment` is what the chain holds, when known.
    /// `now` (unix seconds) is the time certificate windows are checked against; it is never read from a clock.
    pub fn verify(
        &self,
        bundle: &Bundle,
        domain: &Eip712Domain,
        expected_signer: Option<Address>,
        commitment: Option<&Commitment>,
        now: i64,
    ) -> Report {
        let r = &bundle.receipt;
        let mut reasons = BTreeSet::new();
        let blobs = decode_blobs(&bundle.blobs, &mut reasons);

        check_structure(r, &mut reasons);
        check_evidence_blobs(r, &bundle.blobs, &mut reasons);

        let phi_step = r.steps.last().filter(|s| s.step_type == StepType::PhiEval);
        if r.header.phi_hash != jcs_hash(&r.header.phi)
            || phi_step.is_some_and(|s| s.input_digest != jcs_hash(&r.header.phi))
        {
            reasons.insert(Reason::PhiHashMismatch);
        }

        let leaves: Vec<B256> = r.steps.iter().map(leaf).collect();
        if chain(jcs_hash(&r.header), &leaves) != r.terminal_hash {
            reasons.insert(Reason::ChainMismatch);
        }
        if merkle_root(&leaves) != r.root {
            reasons.insert(Reason::RootMismatch);
        }
        if Meter::sum(&r.steps) != r.meter {
            reasons.insert(Reason::MeterMismatch);
        }
        if body_hash(r) != r.body_hash {
            reasons.insert(Reason::BodyHashMismatch);
        }
        let recovered = recover_signer(r, domain);
        let signature_ok = recovered.is_some_and(|addr| {
            Some(addr) == r.header.attestation.signing_key()
                && expected_signer.is_none_or(|e| e == addr)
        });
        if !signature_ok {
            reasons.insert(Reason::BadSignature);
        }
        if let Some(c) = commitment
            && (c.root != r.root
                || c.terminal_hash != r.terminal_hash
                || c.body_hash != r.body_hash
                || c.cost_micros != U256::from(r.meter.usd_micros))
        {
            reasons.insert(Reason::CommitmentMismatch);
        }

        let attested = self.check_attestation(r, recovered, now, &mut reasons);

        let phi_holds = phi_step
            .and_then(|s| blobs.get(&s.output_digest))
            .and_then(|bytes| serde_json::from_slice::<PhiResult>(bytes).ok())
            .map(|result| {
                let holds = mergit_spec::phi_holds(&r.header.phi, &result);
                if holds != result.holds {
                    reasons.insert(Reason::PhiResultContradicted);
                }
                holds
            });

        let failing = reasons.iter().any(|r| !r.is_informational());
        let status = if failing {
            Status::Invalid
        } else if attested {
            Status::Valid
        } else if r.header.attestation.kind == UNATTESTED {
            Status::UnattestedValid
        } else {
            // Unreachable: every unverified attested claim inserts a failing reason. Never `valid` regardless.
            Status::Invalid
        };
        Report {
            status,
            reasons: reasons.into_iter().collect(),
            phi_holds,
        }
    }

    /// Returns `true` only when a v1 receipt of a registered kind carries a document that verifies against the
    /// policy's roots for that kind at `now`, attests to the header's measurement, which the policy allows,
    /// and binds the header's `runtime_key`, which is also the key that signed. Every other outcome for an
    /// attested kind inserts a failing reason, so a false claim of attestation is invalid.
    fn check_attestation(
        &self,
        r: &SealedReceipt,
        recovered: Option<Address>,
        now: i64,
        reasons: &mut BTreeSet<Reason>,
    ) -> bool {
        let att = &r.header.attestation;
        let v1 = r.header.version == VERSION_V1;

        if att.kind == UNATTESTED {
            reasons.insert(Reason::Unattested);
            let well_formed =
                att.dev_key.is_some() && att.runtime_key.is_none() && att.measurement.is_none();
            if v1 || r.attestation_document.is_some() || !well_formed {
                reasons.insert(Reason::AttestationUnsupported);
            }
            return false;
        }

        // An attested kind must be v1, compiled in, and claim exactly a runtime key and a measurement. When it
        // is not, nothing about the attestation can be judged, so this is the only attestation reason.
        let (Some(runtime_key), Some(measurement), None) =
            (att.runtime_key, att.measurement.as_deref(), att.dev_key)
        else {
            reasons.insert(Reason::AttestationUnsupported);
            return false;
        };
        let Some(checker) = self.verifiers.get(att.kind.as_str()).filter(|_| v1) else {
            reasons.insert(Reason::AttestationUnsupported);
            return false;
        };

        // No document, or no roots to verify one against: the claim cannot be verified.
        let Some(document) = r.attestation_document.as_ref() else {
            reasons.insert(Reason::AttestationInvalid);
            return false;
        };
        let Some(trusted) = self.policy.0.get(&att.kind).filter(|k| !k.roots.is_empty()) else {
            reasons.insert(Reason::AttestationInvalid);
            return false;
        };
        // A document that fails reports this reason only: its claims are not trusted enough to compare.
        let Ok(claims) = checker.verify_document(document, &trusted.roots, now) else {
            reasons.insert(Reason::AttestationInvalid);
            return false;
        };

        let header_measurement = normalise_measurement(measurement);
        let measurement_ok = header_measurement.is_some()
            && normalise_measurement(&claims.measurement) == header_measurement
            && trusted.allows(measurement);
        if !measurement_ok {
            reasons.insert(Reason::AttestationMeasurement);
        }
        let key_ok = claims.bound_key == runtime_key && recovered == Some(runtime_key);
        if !key_ok {
            reasons.insert(Reason::AttestationKeyMismatch);
        }
        measurement_ok && key_ok
    }
}

fn decode_blobs(
    raw: &BTreeMap<B256, String>,
    reasons: &mut BTreeSet<Reason>,
) -> BTreeMap<B256, Vec<u8>> {
    let mut out = BTreeMap::new();
    for (digest, b64) in raw {
        match STANDARD.decode(b64) {
            Ok(bytes) if keccak256(&bytes) == *digest => {
                out.insert(*digest, bytes);
            }
            _ => {
                reasons.insert(Reason::BlobDigestMismatch);
            }
        }
    }
    out
}

fn check_structure(r: &SealedReceipt, reasons: &mut BTreeSet<Reason>) {
    let seqs: Vec<u32> = r.steps.iter().map(|s| s.seq).collect();
    if !seqs.windows(2).all(|w| w[0] < w[1]) {
        reasons.insert(Reason::SeqOrder);
    } else if seqs.iter().enumerate().any(|(i, s)| *s as usize != i + 1) {
        reasons.insert(Reason::SeqGap);
    }
    if r.evidence.iter().any(|e| !seqs.contains(e)) {
        reasons.insert(Reason::SeqGap);
    }

    let phi_positions: Vec<usize> = r
        .steps
        .iter()
        .enumerate()
        .filter(|(_, s)| s.step_type == StepType::PhiEval)
        .map(|(i, _)| i)
        .collect();
    match phi_positions.as_slice() {
        [] => {
            reasons.insert(Reason::NoPhiEval);
        }
        [i] if *i == r.steps.len() - 1 => {
            if !r.evidence.contains(&r.steps[*i].seq) {
                reasons.insert(Reason::PhiEvalNotEvidence);
            }
        }
        _ => {
            reasons.insert(Reason::PhiEvalNotLast);
        }
    }
}

fn check_evidence_blobs(
    r: &SealedReceipt,
    raw: &BTreeMap<B256, String>,
    reasons: &mut BTreeSet<Reason>,
) {
    // Absence only: a blob that is present but corrupt is BLOB_DIGEST_MISMATCH, reported while decoding.
    let missing = |d: &B256| !raw.contains_key(d);
    if r.steps
        .iter()
        .filter(|s| r.evidence.contains(&s.seq))
        .any(|s| missing(&s.input_digest) || missing(&s.output_digest))
    {
        reasons.insert(Reason::BlobMissing);
    }
}

/// The address the EIP-712 signature recovers to, if it is a well-formed signature at all.
fn recover_signer(r: &SealedReceipt, domain: &Eip712Domain) -> Option<Address> {
    let sig = Signature::try_from(r.signature.as_ref()).ok()?;
    let msg = Receipt {
        taskId: r.header.task_id,
        root: r.root,
        terminalHash: r.terminal_hash,
        bodyHash: r.body_hash,
        costMicros: U256::from(r.meter.usd_micros),
    };
    sig.recover_address_from_prehash(&msg.eip712_signing_hash(domain))
        .ok()
}
