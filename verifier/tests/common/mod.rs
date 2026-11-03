//! Builds receipt bundles for verifier tests from the shared v0 vectors, resealed with `mergit-spec` functions
//! only. Deliberately independent of `runtime/` (mergit-receipt): the verifier must not trust the builder.
#![allow(dead_code)]

use alloy_primitives::{Address, Bytes, U256};
use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;
use alloy_sol_types::{Eip712Domain, SolStruct};
use mergit_spec::*;
use serde_json::Value;

pub const CHAIN_ID: u64 = 84532;

pub fn registry() -> Address {
    Address::with_last_byte(1)
}

pub fn domain() -> Eip712Domain {
    receipt_domain(CHAIN_ID, registry())
}

pub fn vectors_dir() -> String {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../spec/vectors").to_string()
}

pub fn vector(name: &str) -> Value {
    let p = format!("{}/{name}.json", vectors_dir());
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// Every v0 receipt vector, sorted by name. `ids.json` is not a receipt vector, and the attested (v1) vectors
/// are exercised by `vectors.rs`, so both are filtered out: a v0 vector has a `bundle` and header version v0.
pub fn all_vectors() -> Vec<Value> {
    let mut out: Vec<Value> = std::fs::read_dir(vectors_dir())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap() != "ids.json")
        .map(|p| serde_json::from_str::<Value>(&std::fs::read_to_string(p).unwrap()).unwrap())
        .filter(|v| {
            v.get("bundle")
                .is_some_and(|b| b["receipt"]["header"]["version"] == VERSION)
        })
        .collect();
    out.sort_by_key(|v| v["name"].as_str().unwrap().to_string());
    out
}

/// A deterministic test key; `n` picks a different key.
pub fn key(n: u8) -> PrivateKeySigner {
    let mut bytes = [0u8; 32];
    bytes[31] = n;
    bytes[0] = 0x42;
    PrivateKeySigner::from_slice(&bytes).unwrap()
}

/// Recomputes `terminal_hash`, `root`, `body_hash` and the signature after a header or document change.
pub fn reseal(bundle: &mut Bundle, signer: &PrivateKeySigner) {
    let r = &mut bundle.receipt;
    let leaves: Vec<_> = r.steps.iter().map(leaf).collect();
    r.terminal_hash = chain(jcs_hash(&r.header), &leaves);
    r.root = merkle_root(&leaves);
    r.body_hash = body_hash(r);
    let msg = Receipt {
        taskId: r.header.task_id,
        root: r.root,
        terminalHash: r.terminal_hash,
        bodyHash: r.body_hash,
        costMicros: U256::from(r.meter.usd_micros),
    };
    let sig = signer
        .sign_hash_sync(&msg.eip712_signing_hash(&domain()))
        .unwrap();
    r.signature = Bytes::copy_from_slice(&sig.as_bytes());
}

/// `valid_minimal` with the given version, attestation and document, resealed and signed by `signer`.
pub fn bundle_with(
    version: &str,
    attestation: Attestation,
    document: Option<&[u8]>,
    signer: &PrivateKeySigner,
) -> Bundle {
    let mut bundle: Bundle =
        serde_json::from_value(vector("valid_minimal")["bundle"].clone()).unwrap();
    bundle.receipt.header.version = version.to_string();
    bundle.receipt.header.attestation = attestation;
    bundle.receipt.attestation_document = document.map(Bytes::copy_from_slice);
    reseal(&mut bundle, signer);
    bundle
}

/// A v1 bundle of `kind` claiming `measurement`, signed by (and claiming) `signer`'s key, carrying `document`.
pub fn v1_bundle(
    kind: &str,
    measurement: &str,
    document: Option<&[u8]>,
    signer: &PrivateKeySigner,
) -> Bundle {
    bundle_with(
        VERSION_V1,
        Attestation::attested(kind, signer.address(), measurement),
        document,
        signer,
    )
}
