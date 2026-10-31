//! The test-only attestation kind. Compiled only with `--features test-attestation`; the production build
//! must never contain it (see `test_kind_off.rs` and the CI guard).
#![cfg(feature = "test-attestation")]

use alloy_primitives::Address;
use mergit_verifier::test_kind::{TEST_KIND, issue_test_document, test_root_public_key};
use mergit_verifier::{
    AttestationVerifier, DocError, KindPolicy, Reason, Status, TrustPolicy, Verifier,
};

mod common;

const NOW: i64 = 1_800_000_000;
const M: &str = "aabbccdd";

fn checker() -> Box<dyn AttestationVerifier> {
    // Direct checker; registration through `Verifier::new` is covered by the end_to_end tests below.
    Box::new(mergit_verifier::test_kind::TestKind)
}

fn roots() -> Vec<Vec<u8>> {
    vec![test_root_public_key()]
}

fn key() -> Address {
    Address::repeat_byte(0x11)
}

#[test]
fn good_document_verifies() {
    let doc = issue_test_document(key(), M, NOW + 10);
    let claims = checker().verify_document(&doc, &roots(), NOW).unwrap();
    assert_eq!(claims.measurement, M);
    assert_eq!(claims.bound_key, key());
    assert_eq!(checker().kind(), TEST_KIND);
}

#[test]
fn tampered_document_is_untrusted() {
    let doc = issue_test_document(key(), M, NOW + 10);
    let text = String::from_utf8(doc).unwrap().replace(M, "aabbccde");
    assert_eq!(
        checker().verify_document(text.as_bytes(), &roots(), NOW),
        Err(DocError::Untrusted)
    );
}

#[test]
fn wrong_root_is_untrusted() {
    let doc = issue_test_document(key(), M, NOW + 10);
    assert_eq!(
        checker().verify_document(&doc, &[vec![9u8; 32]], NOW),
        Err(DocError::Untrusted)
    );
    assert_eq!(
        checker().verify_document(&doc, &[], NOW),
        Err(DocError::Untrusted)
    );
}

#[test]
fn window_boundary() {
    let doc = issue_test_document(key(), M, NOW);
    assert!(checker().verify_document(&doc, &roots(), NOW).is_ok());
    assert_eq!(
        checker().verify_document(&doc, &roots(), NOW + 1),
        Err(DocError::Expired)
    );
}

#[test]
fn garbage_never_panics() {
    let good = String::from_utf8(issue_test_document(key(), M, NOW)).unwrap();
    let sig_start = good.find("0x").unwrap();
    let cases: Vec<Vec<u8>> = vec![
        b"".to_vec(),
        b"{".to_vec(),
        vec![0xff; 1 << 20],
        br#"{"runtime_key":"0x1111111111111111111111111111111111111111","measurement":"aa","not_after":1}"#.to_vec(),
        // wrong-length signature
        format!(
            "{}0x{}\"}}",
            &good[..sig_start],
            "ab".repeat(10)
        )
        .into_bytes(),
        // odd-length hex signature
        format!("{}0xabc\"}}", &good[..sig_start]).into_bytes(),
        // signature not hex
        format!("{}0xzz\"}}", &good[..sig_start]).into_bytes(),
        // bad runtime key
        br#"{"runtime_key":"0x12","measurement":"aa","not_after":1,"signature":"0x00"}"#.to_vec(),
        // wrong types
        br#"{"runtime_key":1,"measurement":2,"not_after":"x","signature":3}"#.to_vec(),
    ];
    for c in cases {
        assert_eq!(
            checker().verify_document(&c, &roots(), NOW),
            Err(DocError::Malformed),
            "{:?}",
            String::from_utf8_lossy(&c[..c.len().min(60)])
        );
    }
    // A malformed root must not panic either.
    let doc = issue_test_document(key(), M, NOW);
    assert!(
        checker()
            .verify_document(&doc, &[vec![1, 2, 3]], NOW)
            .is_err()
    );
}

fn policy(roots: Vec<Vec<u8>>) -> TrustPolicy {
    let mut p = TrustPolicy::default();
    p.0.insert(
        TEST_KIND.into(),
        KindPolicy {
            roots,
            measurements: vec![M.into()],
        },
    );
    p
}

#[test]
fn end_to_end_valid_through_verifier_new() {
    let signer = common::key(1);
    let doc = issue_test_document(signer.address(), M, NOW + 10);
    let bundle = common::v1_bundle(TEST_KIND, M, Some(&doc), &signer);
    let report = Verifier::new(policy(roots())).verify(&bundle, &common::domain(), None, None, NOW);
    assert_eq!(report.status, Status::Valid, "{:?}", report.reasons);
}

#[test]
fn end_to_end_without_the_root_is_invalid() {
    let signer = common::key(1);
    let doc = issue_test_document(signer.address(), M, NOW + 10);
    let bundle = common::v1_bundle(TEST_KIND, M, Some(&doc), &signer);
    let report = Verifier::new(policy(vec![])).verify(&bundle, &common::domain(), None, None, NOW);
    assert_eq!(report.status, Status::Invalid);
    assert_eq!(report.reasons, vec![Reason::AttestationInvalid]);
}
