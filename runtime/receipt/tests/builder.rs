use alloy_primitives::{Address, B256, keccak256};
use alloy_signer_local::PrivateKeySigner;
use alloy_sol_types::SolStruct;
use chrono::{TimeZone, Utc};
use mergit_receipt::{BuildError, ReceiptBuilder, StepInput};
use mergit_spec::*;

const KEY: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

fn signer() -> PrivateKeySigner {
    KEY.parse().unwrap()
}

fn domain() -> alloy_sol_types::Eip712Domain {
    receipt_domain(84532, Address::with_last_byte(1))
}

fn predicate() -> Predicate {
    Predicate {
        kind: "exec/0".into(),
        command: vec!["pytest".into(), "-q".into()],
        expected_exit: 0,
        workdir: ".".into(),
        allowed_paths: Some(vec!["payments/**".into()]),
        artifact_hashes: None,
        timeout_s: 600,
    }
}

fn header() -> Header {
    let phi = predicate();
    Header {
        version: "mergit-receipt/0".into(),
        task_id: keccak256(b"task"),
        plan_id: keccak256(b"plan"),
        requester: Address::with_last_byte(7),
        agent_id: "1".into(),
        category: "test-repair".into(),
        phi_hash: jcs_hash(&phi),
        phi,
        budget_usdc_units: "2000000".into(),
        runtime_image: "mergit-runtime:dev".into(),
        attestation: Attestation::unattested(signer().address()),
        started_at: fmt_time(Utc.with_ymd_and_hms(2026, 10, 27, 10, 0, 0).unwrap()),
    }
}

fn cost(usd: u64) -> Cost {
    Cost {
        model: None,
        input_tokens: 0,
        output_tokens: 0,
        tool_calls: 1,
        wall_ms: 10,
        usd_micros: usd,
    }
}

fn step(t: StepType, out: &[u8]) -> StepInput {
    StepInput {
        step_type: t,
        input: b"in".to_vec(),
        output: out.to_vec(),
        exit_status: Some(0),
        cost: cost(5),
        at: Utc.with_ymd_and_hms(2026, 10, 27, 10, 0, 1).unwrap(),
    }
}

fn passing() -> PhiResult {
    PhiResult {
        exit_code: 0,
        changed_paths: vec!["payments/refund.py".into()],
        observed_artifact_hashes: Default::default(),
        stdout_digest: keccak256(b"ok"),
        holds: true,
    }
}

fn sealed() -> Bundle {
    let mut b = ReceiptBuilder::new(header()).unwrap();
    b.add_step(step(StepType::ModelCall, b"plan")).unwrap();
    b.add_step(step(StepType::Command, b"pytest output"))
        .unwrap();
    b.mark_evidence(2).unwrap();
    let end = Utc.with_ymd_and_hms(2026, 10, 27, 10, 0, 9).unwrap();
    b.seal_with_phi(passing(), cost(1), end, &signer(), &domain())
        .unwrap()
}

#[test]
fn add_step_rejects_phi_eval() {
    let mut b = ReceiptBuilder::new(header()).unwrap();
    assert_eq!(
        b.add_step(step(StepType::PhiEval, b"x")),
        Err(BuildError::PhiEvalReserved)
    );
}

#[test]
fn seq_starts_at_one_and_is_gapless() {
    let mut b = ReceiptBuilder::new(header()).unwrap();
    let seqs: Vec<u32> = (0..3)
        .map(|_| b.add_step(step(StepType::ToolCall, b"o")).unwrap())
        .collect();
    assert_eq!(seqs, vec![1, 2, 3]);
}

#[test]
fn mark_evidence_rejects_unknown_seq() {
    let mut b = ReceiptBuilder::new(header()).unwrap();
    b.add_step(step(StepType::ToolCall, b"o")).unwrap();
    assert_eq!(b.mark_evidence(2), Err(BuildError::UnknownSeq(2)));
    assert_eq!(b.mark_evidence(0), Err(BuildError::UnknownSeq(0)));
}

#[test]
fn sealed_receipt_ends_with_phi_eval_in_evidence() {
    let r = sealed().receipt;
    let last = r.steps.last().unwrap();
    assert_eq!(last.step_type, StepType::PhiEval);
    assert_eq!(last.seq, 3);
    assert!(r.evidence.contains(&3) && r.evidence.contains(&2));
}

#[test]
fn phi_eval_input_is_jcs_of_header_phi() {
    let r = sealed().receipt;
    assert_eq!(
        r.steps.last().unwrap().input_digest,
        jcs_hash(&r.header.phi)
    );
    assert_eq!(r.steps.last().unwrap().output_digest, jcs_hash(&passing()));
}

#[test]
fn terminal_hash_matches_chain_over_leaves() {
    let r = sealed().receipt;
    let leaves: Vec<B256> = r.steps.iter().map(leaf).collect();
    assert_eq!(r.terminal_hash, chain(jcs_hash(&r.header), &leaves));
    assert_eq!(r.root, merkle_root(&leaves));
}

#[test]
fn meter_sums_every_step() {
    let r = sealed().receipt;
    assert_eq!(r.meter.usd_micros, 5 + 5 + 1);
    assert_eq!(r.meter.tool_calls, 3);
}

#[test]
fn editing_any_step_changes_root_and_terminal_hash() {
    let r = sealed().receipt;
    let mut steps = r.steps.clone();
    steps[0].exit_status = Some(1);
    let leaves: Vec<B256> = steps.iter().map(leaf).collect();
    assert_ne!(merkle_root(&leaves), r.root);
    assert_ne!(chain(jcs_hash(&r.header), &leaves), r.terminal_hash);
}

#[test]
fn body_hash_covers_everything_but_itself_and_signature() {
    let r = sealed().receipt;
    assert_eq!(r.body_hash, body_hash(&r));
    let mut edited = r.clone();
    edited.ended_at = "2026-10-27T11:00:00.000Z".into();
    assert_ne!(body_hash(&edited), r.body_hash);
}

#[test]
fn signature_recovers_to_signer() {
    let r = sealed().receipt;
    let msg = Receipt {
        taskId: r.header.task_id,
        root: r.root,
        terminalHash: r.terminal_hash,
        bodyHash: r.body_hash,
        costMicros: alloy_primitives::U256::from(r.meter.usd_micros),
    };
    let sig = alloy_primitives::Signature::try_from(r.signature.as_ref()).unwrap();
    let recovered = sig
        .recover_address_from_prehash(&msg.eip712_signing_hash(&domain()))
        .unwrap();
    assert_eq!(recovered, signer().address());
    assert_eq!(r.signature.len(), 65);
}

#[test]
fn bundle_carries_only_the_evidence_blobs() {
    // Invariant 5: a routine audit reads the evidence set, so the bundle carries only evidence blobs.
    let b = sealed();
    let r = &b.receipt;
    for st in &r.steps {
        let evidence = r.evidence.contains(&st.seq);
        assert_eq!(
            b.blobs.contains_key(&st.output_digest),
            evidence,
            "step {}",
            st.seq
        );
    }
}

#[test]
fn sealing_also_returns_the_full_trajectory_for_challenge_disclosure() {
    let mut b = ReceiptBuilder::new(header()).unwrap();
    b.add_step(step(StepType::ModelCall, b"plan")).unwrap();
    let end = Utc.with_ymd_and_hms(2026, 10, 27, 10, 0, 9).unwrap();
    let (bundle, trajectory) = b
        .seal_with_phi_full(passing(), cost(1), end, &signer(), &domain())
        .unwrap();
    for st in &bundle.receipt.steps {
        assert_eq!(
            trajectory.get(&st.output_digest).map(keccak256),
            Some(st.output_digest)
        );
        assert_eq!(
            trajectory.get(&st.input_digest).map(keccak256),
            Some(st.input_digest)
        );
    }
}

#[test]
fn header_with_wrong_phi_hash_is_rejected() {
    let mut h = header();
    h.phi_hash = B256::ZERO;
    assert!(matches!(
        ReceiptBuilder::new(h),
        Err(BuildError::PhiHashMismatch)
    ));
}

#[test]
fn header_claiming_attestation_is_rejected() {
    let mut h = header();
    h.attestation.kind = "tee".into();
    assert!(matches!(
        ReceiptBuilder::new(h),
        Err(BuildError::AttestationNotUnattested)
    ));
}

#[test]
fn seal_rejects_signer_other_than_dev_key() {
    let b = ReceiptBuilder::new(header()).unwrap();
    let other = PrivateKeySigner::random();
    let end = Utc.with_ymd_and_hms(2026, 10, 27, 10, 0, 9).unwrap();
    assert_eq!(
        b.seal_with_phi(passing(), cost(1), end, &other, &domain())
            .unwrap_err(),
        BuildError::SignerMismatch
    );
}

#[test]
fn seal_rejects_phi_result_whose_holds_is_wrong() {
    let b = ReceiptBuilder::new(header()).unwrap();
    let mut lie = passing();
    lie.exit_code = 1; // Φ expects 0, so holds must be false
    let end = Utc.with_ymd_and_hms(2026, 10, 27, 10, 0, 9).unwrap();
    assert_eq!(
        b.seal_with_phi(lie, cost(1), end, &signer(), &domain())
            .unwrap_err(),
        BuildError::PhiResultContradicted
    );
}

#[test]
fn bundle_round_trips_through_json() {
    let b = sealed();
    let back: Bundle = serde_json::from_str(&serde_json::to_string(&b).unwrap()).unwrap();
    assert_eq!(back, b);
}

const MEASUREMENT: &str = "sha256:aabbcc";

fn v1_header(kind: &str) -> Header {
    let mut h = header();
    h.version = VERSION_V1.into();
    h.attestation = Attestation::attested(kind, signer().address(), MEASUREMENT);
    h
}

fn seal(b: ReceiptBuilder, who: &PrivateKeySigner) -> Result<Bundle, BuildError> {
    let end = Utc.with_ymd_and_hms(2026, 10, 27, 10, 0, 9).unwrap();
    b.seal_with_phi(passing(), cost(1), end, who, &domain())
}

#[test]
fn v1_header_with_attested_kind_builds_and_carries_document() {
    let doc = b"opaque document bytes".to_vec();
    let plain = seal(ReceiptBuilder::new(v1_header("tee")).unwrap(), &signer()).unwrap();
    assert_eq!(plain.receipt.attestation_document, None);
    let b = ReceiptBuilder::new(v1_header("tee"))
        .unwrap()
        .with_attestation_document(doc.clone());
    let bundle = seal(b, &signer()).unwrap();
    assert_eq!(bundle.receipt.attestation_document, Some(doc.into()));
    assert_eq!(bundle.receipt.body_hash, plain.receipt.body_hash);
}

#[test]
fn v0_with_attested_kind_rejected() {
    let mut h = v1_header("tee");
    h.version = VERSION.into();
    assert!(matches!(
        ReceiptBuilder::new(h),
        Err(BuildError::AttestationNotUnattested)
    ));
}

#[test]
fn v1_with_unattested_kind_rejected() {
    let mut h = header();
    h.version = VERSION_V1.into();
    assert!(matches!(
        ReceiptBuilder::new(h),
        Err(BuildError::AttestationNotUnattested)
    ));
}

#[test]
fn v1_missing_measurement_rejected() {
    let mut h = v1_header("tee");
    h.attestation.measurement = None;
    assert!(matches!(
        ReceiptBuilder::new(h),
        Err(BuildError::AttestationNotUnattested)
    ));
}

#[test]
fn v1_missing_runtime_key_or_with_dev_key_rejected() {
    let mut h = v1_header("tee");
    h.attestation.runtime_key = None;
    assert!(matches!(
        ReceiptBuilder::new(h),
        Err(BuildError::AttestationNotUnattested)
    ));
    let mut h = v1_header("tee");
    h.attestation.dev_key = Some(signer().address());
    assert!(matches!(
        ReceiptBuilder::new(h),
        Err(BuildError::AttestationNotUnattested)
    ));
}

#[test]
fn seal_rejects_signer_other_than_runtime_key() {
    let b = ReceiptBuilder::new(v1_header("tee")).unwrap();
    assert_eq!(
        seal(b, &PrivateKeySigner::random()).unwrap_err(),
        BuildError::SignerMismatch
    );
}

#[cfg(feature = "test-attestation")]
#[test]
fn builder_carries_an_issued_test_document() {
    let doc = mergit_verifier::test_kind::issue_test_document(
        signer().address(),
        MEASUREMENT,
        4_000_000_000,
    );
    let b = ReceiptBuilder::new(v1_header(mergit_verifier::test_kind::TEST_KIND))
        .unwrap()
        .with_attestation_document(doc.clone());
    let bundle = seal(b, &signer()).unwrap();
    assert_eq!(bundle.receipt.attestation_document, Some(doc.into()));
}

#[test]
fn v0_header_with_runtime_key_rejected() {
    let mut h = header();
    h.attestation.runtime_key = Some(signer().address());
    assert!(matches!(
        ReceiptBuilder::new(h),
        Err(BuildError::AttestationNotUnattested)
    ));
}

#[test]
fn v0_header_with_measurement_rejected() {
    let mut h = header();
    h.attestation.measurement = Some(MEASUREMENT.into());
    assert!(matches!(
        ReceiptBuilder::new(h),
        Err(BuildError::AttestationNotUnattested)
    ));
}

#[test]
fn v0_header_without_dev_key_rejected() {
    let mut h = header();
    h.attestation.dev_key = None;
    assert!(matches!(
        ReceiptBuilder::new(h),
        Err(BuildError::AttestationNotUnattested)
    ));
}

#[test]
fn unattested_with_document_cannot_seal() {
    let b = ReceiptBuilder::new(header())
        .unwrap()
        .with_attestation_document(b"doc".to_vec());
    assert_eq!(
        seal(b, &signer()).unwrap_err(),
        BuildError::AttestationNotUnattested
    );
}

#[test]
fn v1_attested_without_document_still_seals() {
    let bundle = seal(ReceiptBuilder::new(v1_header("tee")).unwrap(), &signer()).unwrap();
    assert_eq!(bundle.receipt.attestation_document, None);
}
