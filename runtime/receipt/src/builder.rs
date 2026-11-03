use alloy_primitives::{B256, Bytes, U256, keccak256};
use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;
use alloy_sol_types::{Eip712Domain, SolStruct};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use mergit_spec::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BuildError {
    #[error("phi_eval is reserved: only sealing appends it")]
    PhiEvalReserved,
    #[error("no step with seq {0}")]
    UnknownSeq(u32),
    #[error("header phi_hash does not match the predicate")]
    PhiHashMismatch,
    #[error("attestation kind does not match the receipt version")]
    AttestationNotUnattested,
    #[error("unsupported receipt version or predicate kind")]
    UnsupportedVersion,
    #[error("the signer is not the header's dev_key")]
    SignerMismatch,
    #[error("the result's holds field disagrees with the predicate")]
    PhiResultContradicted,
    #[error("signing failed: {0}")]
    Signing(String),
}

/// One step as the harness observed it. Digests are computed here from the raw bytes.
pub struct StepInput {
    pub step_type: StepType,
    pub input: Vec<u8>,
    pub output: Vec<u8>,
    pub exit_status: Option<i32>,
    pub cost: Cost,
    pub at: DateTime<Utc>,
}

/// Append-only receipt under construction.
#[derive(Debug)]
pub struct ReceiptBuilder {
    header: Header,
    steps: Vec<Step>,
    evidence: BTreeSet<u32>,
    blobs: BTreeMap<B256, Vec<u8>>,
    attestation_document: Option<Bytes>,
}

impl ReceiptBuilder {
    pub fn new(header: Header) -> Result<Self, BuildError> {
        if (header.version != VERSION && header.version != VERSION_V1)
            || header.phi.kind != PREDICATE_KIND
        {
            return Err(BuildError::UnsupportedVersion);
        }
        // v0 is unattested with a dev key; v1 is an attested kind with a runtime key and a measurement.
        let att = &header.attestation;
        let consistent = if header.version == VERSION {
            att.kind == UNATTESTED
                && att.dev_key.is_some()
                && att.runtime_key.is_none()
                && att.measurement.is_none()
        } else {
            att.kind != UNATTESTED
                && att.runtime_key.is_some()
                && att.measurement.is_some()
                && att.dev_key.is_none()
        };
        if !consistent {
            return Err(BuildError::AttestationNotUnattested);
        }
        if header.phi_hash != jcs_hash(&header.phi) {
            return Err(BuildError::PhiHashMismatch);
        }
        Ok(Self {
            header,
            steps: Vec::new(),
            evidence: BTreeSet::new(),
            blobs: BTreeMap::new(),
            attestation_document: None,
        })
    }

    /// Attaches the attestation document. It travels beside the receipt, outside `body_hash`.
    pub fn with_attestation_document(mut self, doc: Vec<u8>) -> Self {
        self.attestation_document = Some(Bytes::from(doc));
        self
    }

    pub fn header(&self) -> &Header {
        &self.header
    }

    /// Appends a step and returns its `seq`. Refuses `phi_eval`, which only `seal_with_phi` may add.
    pub fn add_step(&mut self, s: StepInput) -> Result<u32, BuildError> {
        if s.step_type == StepType::PhiEval {
            return Err(BuildError::PhiEvalReserved);
        }
        Ok(self.push(s))
    }

    pub fn mark_evidence(&mut self, seq: u32) -> Result<(), BuildError> {
        if seq == 0 || seq as usize > self.steps.len() {
            return Err(BuildError::UnknownSeq(seq));
        }
        self.evidence.insert(seq);
        Ok(())
    }

    /// Appends the `phi_eval` step as the last step, marks it as evidence, and signs. The bundle carries the
    /// evidence blobs only, so a routine audit reads evidence, not the whole trajectory (invariant 5).
    pub fn seal_with_phi(
        self,
        result: PhiResult,
        cost: Cost,
        ended_at: DateTime<Utc>,
        signer: &PrivateKeySigner,
        domain: &Eip712Domain,
    ) -> Result<Bundle, BuildError> {
        self.seal_with_phi_full(result, cost, ended_at, signer, domain)
            .map(|(bundle, _)| bundle)
    }

    /// As `seal_with_phi`, and also returns the raw bytes of every step. The operator keeps them: a bonded
    /// challenge can compel the full trajectory (paper §6.3).
    pub fn seal_with_phi_full(
        mut self,
        result: PhiResult,
        cost: Cost,
        ended_at: DateTime<Utc>,
        signer: &PrivateKeySigner,
        domain: &Eip712Domain,
    ) -> Result<(Bundle, BTreeMap<B256, Vec<u8>>), BuildError> {
        // An unattested receipt has no document to carry: the verifier would call it unsupported.
        if self.header.attestation.kind == UNATTESTED && self.attestation_document.is_some() {
            return Err(BuildError::AttestationNotUnattested);
        }
        if Some(signer.address()) != self.header.attestation.signing_key() {
            return Err(BuildError::SignerMismatch);
        }
        if result.holds != phi_holds(&self.header.phi, &result) {
            return Err(BuildError::PhiResultContradicted);
        }
        let seq = self.push(StepInput {
            step_type: StepType::PhiEval,
            input: jcs_bytes(&self.header.phi),
            output: jcs_bytes(&result),
            exit_status: Some(result.exit_code),
            cost,
            at: ended_at,
        });
        self.evidence.insert(seq);

        let leaves: Vec<B256> = self.steps.iter().map(leaf).collect();
        let mut receipt = SealedReceipt {
            terminal_hash: chain(jcs_hash(&self.header), &leaves),
            root: merkle_root(&leaves),
            meter: Meter::sum(&self.steps),
            header: self.header,
            steps: self.steps,
            evidence: self.evidence.into_iter().collect(),
            ended_at: fmt_time(ended_at),
            body_hash: B256::ZERO,
            signature: Bytes::new(),
            attestation_document: self.attestation_document,
        };
        receipt.body_hash = body_hash(&receipt);
        receipt.signature = sign(&receipt, signer, domain)?;
        let evidence_digests: BTreeSet<B256> = receipt
            .steps
            .iter()
            .filter(|st| receipt.evidence.contains(&st.seq))
            .flat_map(|st| [st.input_digest, st.output_digest])
            .collect();
        let blobs = self
            .blobs
            .iter()
            .filter(|(k, _)| evidence_digests.contains(*k))
            .map(|(k, v)| (*k, STANDARD.encode(v)))
            .collect();
        Ok((Bundle { receipt, blobs }, self.blobs))
    }

    fn push(&mut self, s: StepInput) -> u32 {
        let seq = self.steps.len() as u32 + 1;
        let (input_digest, output_digest) = (keccak256(&s.input), keccak256(&s.output));
        self.blobs.insert(input_digest, s.input);
        self.blobs.insert(output_digest, s.output);
        self.steps.push(Step {
            seq,
            step_type: s.step_type,
            input_digest,
            output_digest,
            exit_status: s.exit_status,
            cost: s.cost,
            at: fmt_time(s.at),
        });
        seq
    }
}

/// EIP-712 signature over the commitment, 65 bytes `r ‖ s ‖ v` with `v` in {27, 28}.
pub(crate) fn sign(
    r: &SealedReceipt,
    signer: &PrivateKeySigner,
    domain: &Eip712Domain,
) -> Result<Bytes, BuildError> {
    let msg = Receipt {
        taskId: r.header.task_id,
        root: r.root,
        terminalHash: r.terminal_hash,
        bodyHash: r.body_hash,
        costMicros: U256::from(r.meter.usd_micros),
    };
    let sig = signer
        .sign_hash_sync(&msg.eip712_signing_hash(domain))
        .map_err(|e| BuildError::Signing(e.to_string()))?;
    Ok(Bytes::copy_from_slice(&sig.as_bytes()))
}
