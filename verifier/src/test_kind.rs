//! A fake attestation kind for tests: `test-ed25519`, signed by a fixed, public ed25519 key.
//!
//! Anyone can mint a document of this kind, so it attests nothing. It exists to exercise the verifier core
//! end to end without hardware. It is compiled only with the `test-attestation` feature, which no release
//! package may enable (CI checks `cargo tree`).
//!
//! Document: JSON `{"runtime_key","measurement","not_after","signature"}`; `signature` is `0x`-hex ed25519 over
//! the JCS bytes of the first three fields. The policy's roots are raw 32-byte public keys.

use crate::{AttestationVerifier, Claims, DocError};
use alloy_primitives::{Address, hex};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier as _, VerifyingKey};
use mergit_spec::jcs_bytes;
use serde::{Deserialize, Serialize};

pub const TEST_KIND: &str = "test-ed25519";

const SEED: [u8; 32] = [7u8; 32];

/// The fixed root: the public key of the seed `[7u8; 32]`.
pub fn test_root_public_key() -> Vec<u8> {
    SigningKey::from_bytes(&SEED)
        .verifying_key()
        .to_bytes()
        .to_vec()
}

#[derive(Serialize)]
struct Signed<'a> {
    runtime_key: &'a str,
    measurement: &'a str,
    not_after: i64,
}

#[derive(Deserialize)]
struct Doc {
    runtime_key: String,
    measurement: String,
    not_after: i64,
    signature: String,
}

#[derive(Serialize)]
struct Out<'a> {
    runtime_key: &'a str,
    measurement: &'a str,
    not_after: i64,
    signature: &'a str,
}

/// A document binding `runtime_key` to `measurement`, valid up to and including `not_after` (unix seconds).
pub fn issue_test_document(runtime_key: Address, measurement: &str, not_after: i64) -> Vec<u8> {
    let key = runtime_key.to_string();
    let msg = jcs_bytes(&Signed {
        runtime_key: &key,
        measurement,
        not_after,
    });
    let sig = SigningKey::from_bytes(&SEED).sign(&msg);
    let sig = format!("0x{}", hex::encode(sig.to_bytes()));
    serde_json::to_vec(&Out {
        runtime_key: &key,
        measurement,
        not_after,
        signature: &sig,
    })
    .expect("plain strings and integers serialise")
}

/// Checker for [`TEST_KIND`].
pub struct TestKind;

impl AttestationVerifier for TestKind {
    fn kind(&self) -> &'static str {
        TEST_KIND
    }

    fn verify_document(
        &self,
        document: &[u8],
        roots: &[Vec<u8>],
        now: i64,
    ) -> Result<Claims, DocError> {
        let doc: Doc = serde_json::from_slice(document).map_err(|_| DocError::Malformed)?;
        let bound_key: Address = doc.runtime_key.parse().map_err(|_| DocError::Malformed)?;
        let sig = hex::decode(&doc.signature).map_err(|_| DocError::Malformed)?;
        let sig = Signature::from_slice(&sig).map_err(|_| DocError::Malformed)?;

        let root = test_root_public_key();
        if !roots.contains(&root) {
            return Err(DocError::Untrusted);
        }
        let vk = VerifyingKey::from_bytes(&root.try_into().map_err(|_| DocError::Malformed)?)
            .map_err(|_| DocError::Malformed)?;
        let msg = jcs_bytes(&Signed {
            runtime_key: &doc.runtime_key,
            measurement: &doc.measurement,
            not_after: doc.not_after,
        });
        vk.verify(&msg, &sig).map_err(|_| DocError::Untrusted)?;
        if now > doc.not_after {
            return Err(DocError::Expired);
        }
        Ok(Claims {
            measurement: doc.measurement,
            bound_key,
        })
    }
}
