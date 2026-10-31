//! The attestation truth table. Each row asserts the exact status and failing reasons. The guards matter
//! more than the happy path: `valid` must be unreachable without a verified document and an allowed
//! measurement, and a false claim of attestation must be `invalid`, not merely unattested.

mod common;

use alloy_primitives::Address;
use common::*;
use mergit_spec::{Attestation, Bundle, UNATTESTED, VERSION, VERSION_V1};
use mergit_verifier::{
    AttestationVerifier, Claims, DocError, KindPolicy, Reason, Report, Status, TrustPolicy,
    Verifier, verify,
};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

const MOCK: &str = "mock";
const NOW: i64 = 1_800_000_000;
const DOC: &[u8] = b"a mock attestation document";

/// A document checker that ignores the document and the roots and returns a fixed answer, so the tests
/// exercise the verifier core's guards rather than any document format.
struct Mock {
    result: Result<Claims, DocError>,
    calls: Arc<AtomicUsize>,
}

impl AttestationVerifier for Mock {
    fn kind(&self) -> &'static str {
        MOCK
    }
    fn verify_document(
        &self,
        _document: &[u8],
        _roots: &[Vec<u8>],
        _now: i64,
    ) -> Result<Claims, DocError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.result.clone()
    }
}

fn claims(measurement: &str, bound_key: Address) -> Claims {
    Claims {
        measurement: measurement.to_string(),
        bound_key,
    }
}

fn kind_policy(measurements: &[&str]) -> KindPolicy {
    KindPolicy {
        roots: vec![b"mock root".to_vec()],
        measurements: measurements.iter().map(|m| m.to_string()).collect(),
    }
}

fn policy(kind: &str, measurements: &[&str]) -> TrustPolicy {
    TrustPolicy(BTreeMap::from([(
        kind.to_string(),
        kind_policy(measurements),
    )]))
}

fn verifier_with(
    policy: TrustPolicy,
    result: Result<Claims, DocError>,
) -> (Verifier, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut v = Verifier::new(policy);
    v.register(Box::new(Mock {
        result,
        calls: calls.clone(),
    }));
    (v, calls)
}

fn run(v: &Verifier, bundle: &Bundle, expected_signer: Option<Address>) -> Report {
    v.verify(bundle, &domain(), expected_signer, None, NOW)
}

/// Reasons that make a receipt invalid, i.e. all but the informational ones.
fn failing(report: &Report) -> Vec<Reason> {
    report
        .reasons
        .iter()
        .copied()
        .filter(|r| !r.is_informational())
        .collect()
}

fn assert_invalid(report: &Report, want: &[Reason]) {
    assert_eq!(report.status, Status::Invalid, "{report:?}");
    assert_eq!(failing(report), want, "{report:?}");
}

#[test]
fn verified_allowed_is_valid() {
    let k = key(1);
    let (v, calls) = verifier_with(policy(MOCK, &["abcd"]), Ok(claims("abcd", k.address())));
    let report = run(
        &v,
        &v1_bundle(MOCK, "abcd", Some(DOC), &k),
        Some(k.address()),
    );
    assert_eq!(report.status, Status::Valid, "{report:?}");
    assert!(report.reasons.is_empty(), "{report:?}");
    assert!(!report.reasons.contains(&Reason::Unattested));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(report.phi_holds, Some(true));
    assert_eq!(serde_json::to_value(report.status).unwrap(), "valid");
}

#[test]
fn empty_policy_is_never_valid() {
    let k = key(1);
    let (v, calls) = verifier_with(TrustPolicy::default(), Ok(claims("abcd", k.address())));
    let report = run(
        &v,
        &v1_bundle(MOCK, "abcd", Some(DOC), &k),
        Some(k.address()),
    );
    assert_invalid(&report, &[Reason::AttestationInvalid]);
    // There are no roots to verify against, so the document checker is not even asked.
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn kind_missing_from_policy_is_never_valid() {
    let k = key(1);
    let (v, calls) = verifier_with(
        policy("other-kind", &["abcd"]),
        Ok(claims("abcd", k.address())),
    );
    let report = run(
        &v,
        &v1_bundle(MOCK, "abcd", Some(DOC), &k),
        Some(k.address()),
    );
    assert_invalid(&report, &[Reason::AttestationInvalid]);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn kind_in_policy_without_roots_is_never_valid() {
    let k = key(1);
    let p = TrustPolicy(BTreeMap::from([(
        MOCK.to_string(),
        KindPolicy {
            roots: vec![],
            measurements: vec!["abcd".into()],
        },
    )]));
    let (v, calls) = verifier_with(p, Ok(claims("abcd", k.address())));
    let report = run(
        &v,
        &v1_bundle(MOCK, "abcd", Some(DOC), &k),
        Some(k.address()),
    );
    assert_invalid(&report, &[Reason::AttestationInvalid]);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn measurement_not_allowed() {
    let k = key(1);
    let (v, _) = verifier_with(policy(MOCK, &["ffff"]), Ok(claims("abcd", k.address())));
    let report = run(
        &v,
        &v1_bundle(MOCK, "abcd", Some(DOC), &k),
        Some(k.address()),
    );
    assert_invalid(&report, &[Reason::AttestationMeasurement]);
}

#[test]
fn empty_measurement_allowlist_is_never_valid() {
    let k = key(1);
    let (v, _) = verifier_with(policy(MOCK, &[]), Ok(claims("abcd", k.address())));
    let report = run(
        &v,
        &v1_bundle(MOCK, "abcd", Some(DOC), &k),
        Some(k.address()),
    );
    assert_invalid(&report, &[Reason::AttestationMeasurement]);
}

#[test]
fn document_measurement_differs_from_header() {
    // The header claims an allowed measurement, but the document attests to a different one.
    let k = key(1);
    let (v, _) = verifier_with(
        policy(MOCK, &["abcd", "ffff"]),
        Ok(claims("ffff", k.address())),
    );
    let report = run(
        &v,
        &v1_bundle(MOCK, "abcd", Some(DOC), &k),
        Some(k.address()),
    );
    assert_invalid(&report, &[Reason::AttestationMeasurement]);
}

#[test]
fn measurement_hex_case_and_prefix_insensitive() {
    let k = key(1);
    let (v, _) = verifier_with(policy(MOCK, &["ABCD"]), Ok(claims("abcd", k.address())));
    let report = run(
        &v,
        &v1_bundle(MOCK, "0xABCD", Some(DOC), &k),
        Some(k.address()),
    );
    assert_eq!(report.status, Status::Valid, "{report:?}");

    let report = run(
        &v,
        &v1_bundle(MOCK, "abce", Some(DOC), &k),
        Some(k.address()),
    );
    assert_invalid(&report, &[Reason::AttestationMeasurement]);

    // `0X` is a prefix too; a case difference alone never flips the outcome either way.
    let (v, _) = verifier_with(policy(MOCK, &["0xabcd"]), Ok(claims("0XAbCd", k.address())));
    let report = run(
        &v,
        &v1_bundle(MOCK, "abcd", Some(DOC), &k),
        Some(k.address()),
    );
    assert_eq!(report.status, Status::Valid, "{report:?}");
}

#[test]
fn malformed_or_empty_measurements_never_match() {
    let k = key(1);
    for (header, doc, allowed) in [
        ("", "", ""),
        ("0x", "0x", "0x"),
        ("0x0xabcd", "0x0xabcd", "0x0xabcd"),
        ("xyz", "xyz", "xyz"),
        (" abcd", " abcd", " abcd"),
    ] {
        let (v, _) = verifier_with(policy(MOCK, &[allowed]), Ok(claims(doc, k.address())));
        let report = run(
            &v,
            &v1_bundle(MOCK, header, Some(DOC), &k),
            Some(k.address()),
        );
        assert_invalid(&report, &[Reason::AttestationMeasurement]);
    }
}

#[test]
fn key_mismatch() {
    let k = key(1);
    let (v, _) = verifier_with(
        policy(MOCK, &["abcd"]),
        Ok(claims("abcd", key(2).address())),
    );
    let report = run(
        &v,
        &v1_bundle(MOCK, "abcd", Some(DOC), &k),
        Some(k.address()),
    );
    assert_invalid(&report, &[Reason::AttestationKeyMismatch]);
}

#[test]
fn signed_by_a_key_other_than_runtime_key() {
    // The document is for the claimed runtime key, but another key signed the receipt.
    let (runtime, other) = (key(1), key(2));
    let (v, _) = verifier_with(
        policy(MOCK, &["abcd"]),
        Ok(claims("abcd", runtime.address())),
    );
    let bundle = bundle_with(
        VERSION_V1,
        Attestation::attested(MOCK, runtime.address(), "abcd"),
        Some(DOC),
        &other,
    );
    let report = run(&v, &bundle, None);
    assert_invalid(
        &report,
        &[Reason::BadSignature, Reason::AttestationKeyMismatch],
    );
}

#[test]
fn expected_signer_differs_is_bad_signature() {
    let k = key(1);
    let (v, _) = verifier_with(policy(MOCK, &["abcd"]), Ok(claims("abcd", k.address())));
    let report = run(
        &v,
        &v1_bundle(MOCK, "abcd", Some(DOC), &k),
        Some(key(2).address()),
    );
    assert_invalid(&report, &[Reason::BadSignature]);
}

#[test]
fn doc_fails_reports_only_invalid() {
    let k = key(1);
    for err in [DocError::Malformed, DocError::Untrusted, DocError::Expired] {
        // Allowed measurement in the policy but not the header's, and a foreign key: none of it may be
        // reported, because an unverified document's claims are not compared.
        let (v, _) = verifier_with(policy(MOCK, &["ffff"]), Err(err));
        let report = run(
            &v,
            &v1_bundle(MOCK, "abcd", Some(DOC), &k),
            Some(k.address()),
        );
        assert_invalid(&report, &[Reason::AttestationInvalid]);
    }
}

#[test]
fn attested_kind_without_document() {
    let k = key(1);
    let (v, calls) = verifier_with(policy(MOCK, &["abcd"]), Ok(claims("abcd", k.address())));
    let report = run(&v, &v1_bundle(MOCK, "abcd", None, &k), Some(k.address()));
    assert_invalid(&report, &[Reason::AttestationInvalid]);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn attested_kind_with_dev_key_is_unsupported() {
    // An attested header must name its key as runtime_key; a dev_key beside it would become the signing key.
    let k = key(1);
    let (v, _) = verifier_with(policy(MOCK, &["abcd"]), Ok(claims("abcd", k.address())));
    let mut att = Attestation::attested(MOCK, k.address(), "abcd");
    att.dev_key = Some(k.address());
    let report = run(
        &v,
        &bundle_with(VERSION_V1, att, Some(DOC), &k),
        Some(k.address()),
    );
    assert_invalid(&report, &[Reason::AttestationUnsupported]);
}

#[test]
fn attested_kind_missing_claims_is_unsupported() {
    let k = key(1);
    let (v, _) = verifier_with(policy(MOCK, &["abcd"]), Ok(claims("abcd", k.address())));
    let mut no_measurement = Attestation::attested(MOCK, k.address(), "abcd");
    no_measurement.measurement = None;
    let mut no_runtime_key = Attestation::attested(MOCK, k.address(), "abcd");
    no_runtime_key.runtime_key = None;
    no_runtime_key.dev_key = Some(k.address());
    for att in [no_measurement, no_runtime_key] {
        let report = run(
            &v,
            &bundle_with(VERSION_V1, att, Some(DOC), &k),
            Some(k.address()),
        );
        assert_invalid(&report, &[Reason::AttestationUnsupported]);
    }
}

#[test]
fn unattested_with_document() {
    let k = key(1);
    let (v, _) = verifier_with(policy(MOCK, &["abcd"]), Ok(claims("abcd", k.address())));
    let bundle = bundle_with(VERSION, Attestation::unattested(k.address()), Some(DOC), &k);
    let report = run(&v, &bundle, Some(k.address()));
    assert_invalid(&report, &[Reason::AttestationUnsupported]);
}

#[test]
fn unattested_under_v1() {
    let k = key(1);
    let (v, _) = verifier_with(policy(MOCK, &["abcd"]), Ok(claims("abcd", k.address())));
    let bundle = bundle_with(VERSION_V1, Attestation::unattested(k.address()), None, &k);
    let report = run(&v, &bundle, Some(k.address()));
    assert_invalid(&report, &[Reason::AttestationUnsupported]);
}

#[test]
fn unattested_with_attested_fields_is_unsupported() {
    let k = key(1);
    let (v, _) = verifier_with(policy(MOCK, &["abcd"]), Ok(claims("abcd", k.address())));
    let mut with_claims = Attestation::unattested(k.address());
    with_claims.runtime_key = Some(k.address());
    with_claims.measurement = Some("abcd".into());
    let mut no_dev_key = Attestation::unattested(k.address());
    no_dev_key.dev_key = None;
    no_dev_key.runtime_key = Some(k.address());
    for att in [with_claims, no_dev_key] {
        let report = run(&v, &bundle_with(VERSION, att, None, &k), Some(k.address()));
        assert_invalid(&report, &[Reason::AttestationUnsupported]);
    }
}

#[test]
fn attested_kind_under_v0() {
    let k = key(1);
    let (v, calls) = verifier_with(policy(MOCK, &["abcd"]), Ok(claims("abcd", k.address())));
    let bundle = bundle_with(
        VERSION,
        Attestation::attested(MOCK, k.address(), "abcd"),
        Some(DOC),
        &k,
    );
    let report = run(&v, &bundle, Some(k.address()));
    assert_invalid(&report, &[Reason::AttestationUnsupported]);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn unknown_kind_no_verifier() {
    let k = key(1);
    // The policy names the kind, but no verifier for it is compiled in.
    let v = Verifier::new(policy(MOCK, &["abcd"]));
    let report = run(
        &v,
        &v1_bundle(MOCK, "abcd", Some(DOC), &k),
        Some(k.address()),
    );
    assert_invalid(&report, &[Reason::AttestationUnsupported]);
}

#[test]
fn a_verifier_registered_for_unattested_is_never_consulted() {
    struct ClaimsUnattested;
    impl AttestationVerifier for ClaimsUnattested {
        fn kind(&self) -> &'static str {
            UNATTESTED
        }
        fn verify_document(&self, _: &[u8], _: &[Vec<u8>], _: i64) -> Result<Claims, DocError> {
            panic!("an unattested receipt has no document to verify")
        }
    }
    let k = key(1);
    let mut v = Verifier::new(policy(UNATTESTED, &["abcd"]));
    v.register(Box::new(ClaimsUnattested));
    let bundle = bundle_with(VERSION, Attestation::unattested(k.address()), None, &k);
    let report = run(&v, &bundle, Some(k.address()));
    assert_eq!(report.status, Status::UnattestedValid, "{report:?}");
    assert_eq!(report.reasons, [Reason::Unattested]);
}

/// A policy that allows everything the mock might claim, for every kind a test uses.
fn permissive() -> TrustPolicy {
    let any = kind_policy(&["abcd"]);
    TrustPolicy(BTreeMap::from([
        (MOCK.to_string(), any.clone()),
        (UNATTESTED.to_string(), any.clone()),
        ("other-kind".to_string(), any),
    ]))
}

#[test]
fn v0_unattested_stays_unattested_valid() {
    // Every v0 vector gives the same report through a permissive Verifier as through the free `verify`,
    // and the same status as the vector expects.
    for vec in all_vectors() {
        let name = vec["name"].as_str().unwrap();
        let bundle: Bundle = serde_json::from_value(vec["bundle"].clone()).unwrap();
        assert_eq!(bundle.receipt.header.version, VERSION, "{name}");
        let signer: Address = vec["signer"].as_str().unwrap().parse().unwrap();
        let (v, calls) = verifier_with(permissive(), Ok(claims("abcd", signer)));
        let got = v.verify(&bundle, &domain(), Some(signer), None, NOW);
        let free = verify(&bundle, &domain(), Some(signer), None);
        assert_eq!(got, free, "{name}");
        assert_ne!(got.status, Status::Valid, "{name}");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "{name}");
        if vec["expect"]["status"] == "unattested_valid" {
            assert_eq!(got.status, Status::UnattestedValid, "{name}");
            assert_eq!(got.reasons, [Reason::Unattested], "{name}");
        }
    }
}

#[test]
fn no_input_combination_reaches_valid_without_document() {
    let k = key(1);
    // Existing vectors under a policy that allows everything: none is valid.
    for vec in all_vectors() {
        let name = vec["name"].as_str().unwrap();
        let bundle: Bundle = serde_json::from_value(vec["bundle"].clone()).unwrap();
        let signer: Address = vec["signer"].as_str().unwrap().parse().unwrap();
        let (v, _) = verifier_with(permissive(), Ok(claims("abcd", signer)));
        for expected in [None, Some(signer)] {
            let report = v.verify(&bundle, &domain(), expected, None, NOW);
            assert_ne!(report.status, Status::Valid, "{name}");
        }
    }

    // Every header shape, version and policy without a document, with a checker that accepts anything.
    let versions = [VERSION, VERSION_V1, "mergit-receipt/2", ""];
    let attestations = [
        Attestation::unattested(k.address()),
        Attestation::attested(MOCK, k.address(), "abcd"),
        Attestation::attested("other-kind", k.address(), "abcd"),
        Attestation::attested(UNATTESTED, k.address(), "abcd"),
        Attestation {
            kind: MOCK.into(),
            dev_key: Some(k.address()),
            runtime_key: Some(k.address()),
            measurement: Some("abcd".into()),
        },
    ];
    let policies = [
        TrustPolicy::default(),
        policy(MOCK, &["abcd"]),
        permissive(),
    ];
    for version in versions {
        for att in &attestations {
            let bundle = bundle_with(version, att.clone(), None, &k);
            for p in &policies {
                let (v, _) = verifier_with(p.clone(), Ok(claims("abcd", k.address())));
                for expected in [None, Some(k.address())] {
                    for now in [0, NOW, i64::MAX] {
                        let report = v.verify(&bundle, &domain(), expected, None, now);
                        assert_ne!(
                            report.status,
                            Status::Valid,
                            "{version} {att:?} {p:?} {expected:?} {now}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn valid_needs_every_condition_at_once() {
    // With a document, exactly one combination is valid: v1, a registered kind with roots in the policy, a
    // document that verifies, its measurement equal to the header's and allowed, its key the signer's.
    let k = key(1);
    let versions = [VERSION, VERSION_V1];
    let kinds = [MOCK, "other-kind", UNATTESTED];
    let policies = [
        ("empty", TrustPolicy::default()),
        ("other kind", policy("other-kind", &["abcd"])),
        ("not allowed", policy(MOCK, &["ffff"])),
        ("allowed", policy(MOCK, &["abcd"])),
    ];
    let results = [
        ("ok", Ok(claims("abcd", k.address()))),
        ("other key", Ok(claims("abcd", key(2).address()))),
        ("other measurement", Ok(claims("ffff", k.address()))),
        ("malformed", Err(DocError::Malformed)),
        ("untrusted", Err(DocError::Untrusted)),
        ("expired", Err(DocError::Expired)),
    ];
    let mut valid = vec![];
    for version in versions {
        for kind in kinds {
            let att = if kind == UNATTESTED {
                Attestation::unattested(k.address())
            } else {
                Attestation::attested(kind, k.address(), "abcd")
            };
            let bundle = bundle_with(version, att, Some(DOC), &k);
            for (pname, p) in &policies {
                for (rname, result) in &results {
                    let (v, _) = verifier_with(p.clone(), result.clone());
                    let report = run(&v, &bundle, Some(k.address()));
                    if report.status == Status::Valid {
                        assert!(failing(&report).is_empty());
                        valid.push((version, kind, *pname, *rname));
                    } else {
                        assert_eq!(report.status, Status::Invalid, "{report:?}");
                        assert!(!failing(&report).is_empty(), "{report:?}");
                    }
                }
            }
        }
    }
    assert_eq!(valid, [(VERSION_V1, MOCK, "allowed", "ok")]);
}

#[test]
fn free_verify_is_the_empty_policy() {
    let k = key(1);
    let bundle = v1_bundle(MOCK, "abcd", Some(DOC), &k);
    let free = verify(&bundle, &domain(), Some(k.address()), None);
    let empty = Verifier::new(TrustPolicy::default()).verify(
        &bundle,
        &domain(),
        Some(k.address()),
        None,
        0,
    );
    assert_eq!(free, empty);
    assert_invalid(&free, &[Reason::AttestationUnsupported]);
}

#[test]
fn trust_policy_json() {
    let p: TrustPolicy = serde_json::from_str(
        r#"{ "mock": { "roots": ["bW9jayByb290"], "measurements": ["ABCD", "0xffff"] } }"#,
    )
    .unwrap();
    assert_eq!(p, policy(MOCK, &["ABCD", "0xffff"]));
    let back: TrustPolicy = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
    assert_eq!(back, p);
    assert_eq!(
        serde_json::from_str::<TrustPolicy>("{}").unwrap(),
        TrustPolicy::default()
    );

    for bad in [
        r#"{ "mock": { "roots": ["not base64!"], "measurements": [] } }"#,
        r#"{ "mock": { "roots": [], "measurements": [], "trust_all": true } }"#,
        r#"{ "mock": { "measurements": [] } }"#,
        r#"{ "mock": { "roots": [] } }"#,
        r#"{ "mock": { "roots": [1], "measurements": [] } }"#,
        r#"[]"#,
    ] {
        assert!(serde_json::from_str::<TrustPolicy>(bad).is_err(), "{bad}");
    }
}

#[test]
fn new_reasons_serialise() {
    for (r, s) in [
        (Reason::AttestationInvalid, "ATTESTATION_INVALID"),
        (Reason::AttestationMeasurement, "ATTESTATION_MEASUREMENT"),
        (Reason::AttestationKeyMismatch, "ATTESTATION_KEY_MISMATCH"),
        (Reason::AttestationUnsupported, "ATTESTATION_UNSUPPORTED"),
        (Reason::Unattested, "UNATTESTED"),
    ] {
        assert_eq!(serde_json::to_value(r).unwrap(), s);
    }
    assert_eq!(serde_json::to_value(Status::Valid).unwrap(), "valid");
    assert_eq!(
        serde_json::to_value(Status::UnattestedValid).unwrap(),
        "unattested_valid"
    );
    assert_eq!(serde_json::to_value(Status::Invalid).unwrap(), "invalid");
}

const ALL: [Reason; 20] = [
    Reason::SeqGap,
    Reason::SeqOrder,
    Reason::ChainMismatch,
    Reason::RootMismatch,
    Reason::BodyHashMismatch,
    Reason::BadSignature,
    Reason::PhiHashMismatch,
    Reason::NoPhiEval,
    Reason::PhiEvalNotLast,
    Reason::PhiEvalNotEvidence,
    Reason::MeterMismatch,
    Reason::BlobMissing,
    Reason::BlobDigestMismatch,
    Reason::PhiResultContradicted,
    Reason::CommitmentMismatch,
    Reason::AttestationUnsupported,
    Reason::AttestationInvalid,
    Reason::AttestationMeasurement,
    Reason::AttestationKeyMismatch,
    Reason::Unattested,
];

/// Fails to compile when a variant is added, so `ALL` and this classification are revisited.
fn expected_informational(r: Reason) -> bool {
    match r {
        Reason::Unattested => true,
        Reason::SeqGap
        | Reason::SeqOrder
        | Reason::ChainMismatch
        | Reason::RootMismatch
        | Reason::BodyHashMismatch
        | Reason::BadSignature
        | Reason::PhiHashMismatch
        | Reason::NoPhiEval
        | Reason::PhiEvalNotLast
        | Reason::PhiEvalNotEvidence
        | Reason::MeterMismatch
        | Reason::BlobMissing
        | Reason::BlobDigestMismatch
        | Reason::PhiResultContradicted
        | Reason::CommitmentMismatch
        | Reason::AttestationUnsupported
        | Reason::AttestationInvalid
        | Reason::AttestationMeasurement
        | Reason::AttestationKeyMismatch => false,
    }
}

#[test]
fn reason_classification() {
    assert!(Reason::Unattested.is_informational());
    let distinct: std::collections::BTreeSet<Reason> = ALL.into_iter().collect();
    assert_eq!(distinct.len(), ALL.len(), "ALL lists a variant twice");
    for r in ALL {
        assert_eq!(r.is_informational(), expected_informational(r), "{r:?}");
        assert_eq!(r.is_informational(), r == Reason::Unattested, "{r:?}");
    }
}
