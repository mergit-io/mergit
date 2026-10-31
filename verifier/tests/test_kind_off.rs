//! With the feature off, the test kind must not exist: a receipt claiming it is `invalid`, unsupported.
#![cfg(not(feature = "test-attestation"))]

mod common;

use common::*;
use mergit_verifier::{KindPolicy, Reason, Status, TrustPolicy, Verifier};

#[test]
fn test_kind_is_unsupported_when_feature_is_off() {
    let signer = key(1);
    let bundle = v1_bundle("test-ed25519", "aabbccdd", Some(b"{}"), &signer);
    let mut policy = TrustPolicy::default();
    policy.0.insert(
        "test-ed25519".into(),
        KindPolicy {
            roots: vec![vec![0u8; 32]],
            measurements: vec!["aabbccdd".into()],
        },
    );
    let report = Verifier::new(policy).verify(&bundle, &domain(), None, None, 1_800_000_000);
    assert_eq!(report.status, Status::Invalid);
    assert_eq!(report.reasons, vec![Reason::AttestationUnsupported]);
}
