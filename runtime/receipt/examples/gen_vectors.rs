//! Writes the receipt test vectors to the directory given as the first argument (normally `spec/vectors`).
//! Every forged vector breaks exactly one rule and is otherwise resealed, so it names one reason code.
//! Run: cargo run -p mergit-receipt --features forgery-fixture,test-attestation --example gen_vectors -- spec/vectors

use alloy_primitives::{Address, B256, Bytes, keccak256};
use alloy_signer_local::PrivateKeySigner;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{TimeZone, Utc};
use mergit_receipt::fixture::{forge, forge_raw, resign};
use mergit_receipt::{ReceiptBuilder, StepInput};
use mergit_spec::*;
use mergit_verifier::test_kind::{TEST_KIND, issue_test_document, test_root_public_key};
use serde_json::{Value, json};
use std::path::Path;

const KEY: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OTHER_KEY: &str = "0x59c6995e998f97a5a0044966f0945389dc9c86dae88c7a8412f4603b6b78690d";
const PLAN_UUID: &str = "3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b";
const CHAIN_ID: u64 = 84532;

fn registry() -> Address {
    Address::with_last_byte(1)
}

fn t(s: u32) -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 27, 10, 0, s).unwrap()
}

fn cost(usd: u64, tools: u64) -> Cost {
    Cost {
        model: None,
        input_tokens: 0,
        output_tokens: 0,
        tool_calls: tools,
        wall_ms: 100,
        usd_micros: usd,
    }
}

fn header(signer: &PrivateKeySigner) -> Header {
    let phi = Predicate {
        kind: PREDICATE_KIND.into(),
        command: vec!["pytest".into(), "tests/test_refund.py".into(), "-q".into()],
        expected_exit: 0,
        workdir: ".".into(),
        allowed_paths: Some(vec!["payments/**".into()]),
        artifact_hashes: None,
        timeout_s: 600,
    };
    Header {
        version: VERSION.into(),
        task_id: task_id(plan_id(PLAN_UUID), 0, 1),
        plan_id: plan_id(PLAN_UUID),
        requester: "0x6E2d4A9c51b07f3e9d28c4a16b0e7f2c3d119A0b"
            .parse()
            .unwrap(),
        agent_id: "1".into(),
        category: "test-repair".into(),
        phi_hash: jcs_hash(&phi),
        phi,
        budget_usdc_units: "2000000".into(),
        runtime_image: "mergit-runtime:dev".into(),
        attestation: Attestation::unattested(signer.address()),
        started_at: fmt_time(t(0)),
    }
}

fn phi_result(holds: bool) -> PhiResult {
    PhiResult {
        exit_code: if holds { 0 } else { 1 },
        changed_paths: vec!["payments/refund.py".into()],
        observed_artifact_hashes: Default::default(),
        stdout_digest: keccak256(b"1 passed"),
        holds,
    }
}

fn minimal(signer: &PrivateKeySigner) -> Bundle {
    let b = ReceiptBuilder::new(header(signer)).unwrap();
    b.seal_with_phi(
        phi_result(true),
        cost(0, 0),
        t(2),
        signer,
        &receipt_domain(CHAIN_ID, registry()),
    )
    .unwrap()
}

fn three_steps(signer: &PrivateKeySigner) -> Bundle {
    let mut b = ReceiptBuilder::new(header(signer)).unwrap();
    let step = |ty, out: &[u8], s| StepInput {
        step_type: ty,
        input: b"prompt or argv".to_vec(),
        output: out.to_vec(),
        exit_status: if ty == StepType::Command {
            Some(0)
        } else {
            None
        },
        cost: cost(1200, 1),
        at: t(s),
    };
    b.add_step(step(StepType::ModelCall, b"edit payments/refund.py", 1))
        .unwrap();
    let run = b
        .add_step(step(StepType::Command, b"1 passed in 0.12s", 3))
        .unwrap();
    b.mark_evidence(run).unwrap();
    b.seal_with_phi(
        phi_result(true),
        cost(0, 0),
        t(4),
        signer,
        &receipt_domain(CHAIN_ID, registry()),
    )
    .unwrap()
}

/// Recomputes root, terminal hash and meter from the (edited) steps.
fn recommit(b: &mut Bundle) {
    let leaves: Vec<B256> = b.receipt.steps.iter().map(leaf).collect();
    b.receipt.root = merkle_root(&leaves);
    b.receipt.terminal_hash = chain(jcs_hash(&b.receipt.header), &leaves);
    b.receipt.meter = Meter::sum(&b.receipt.steps);
}

fn write(
    dir: &Path,
    name: &str,
    bundle: &Bundle,
    signer: Address,
    commitment: Option<Value>,
    status: &str,
    reasons: &[&str],
) {
    let v = json!({
        "name": name,
        "bundle": bundle,
        "domain": {"chain_id": CHAIN_ID, "registry": registry()},
        "signer": signer,
        "commitment": commitment,
        "expect": {"status": status, "reasons": reasons},
    });
    std::fs::write(
        dir.join(format!("{name}.json")),
        serde_json::to_string_pretty(&v).unwrap() + "\n",
    )
    .unwrap();
}

const MEASUREMENT: &str = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const NOT_AFTER: i64 = 2_000_000_000;
const NOW: i64 = 1_800_000_000;

/// A sealed v1 receipt (`valid_minimal`'s shape) claiming `kind` and `measurement` for `signer`'s key,
/// carrying `document` when given.
fn attested(
    kind: &str,
    measurement: &str,
    document: Option<Vec<u8>>,
    signer: &PrivateKeySigner,
) -> Bundle {
    let mut h = header(signer);
    h.version = VERSION_V1.into();
    h.attestation = Attestation::attested(kind, signer.address(), measurement);
    let mut b = ReceiptBuilder::new(h).unwrap();
    if let Some(doc) = document {
        b = b.with_attestation_document(doc);
    }
    b.seal_with_phi(
        phi_result(true),
        cost(0, 0),
        t(2),
        signer,
        &receipt_domain(CHAIN_ID, registry()),
    )
    .unwrap()
}

fn policy(kind: &str, measurements: &[&str]) -> Value {
    json!({kind: {"roots": [STANDARD.encode(test_root_public_key())], "measurements": measurements}})
}

/// An attested-slice vector: `policy` and `now` feed the `Verifier`; `requires` marks vectors that need the
/// `test-attestation` kind compiled in (the harness skips them, asserting `ATTESTATION_UNSUPPORTED`, when it is off).
#[allow(clippy::too_many_arguments)]
fn write_attested(
    dir: &Path,
    name: &str,
    bundle: &Bundle,
    signer: Address,
    policy: Value,
    now: i64,
    requires: bool,
    status: &str,
    reasons: &[&str],
) {
    let mut v = json!({
        "name": name,
        "bundle": bundle,
        "domain": {"chain_id": CHAIN_ID, "registry": registry()},
        "signer": signer,
        "commitment": null,
        "policy": policy,
        "now": now,
        "expect": {"status": status, "reasons": reasons},
    });
    if requires {
        v["requires"] = json!("test-attestation");
    }
    std::fs::write(
        dir.join(format!("{name}.json")),
        serde_json::to_string_pretty(&v).unwrap() + "\n",
    )
    .unwrap();
}

fn attested_vectors(dir: &Path, s: &PrivateKeySigner, other: &PrivateKeySigner) {
    let a = s.address();
    let d = receipt_domain(CHAIN_ID, registry());
    let doc = |key: Address, m: &str, na: i64| issue_test_document(key, m, na);
    let good_doc = || doc(a, MEASUREMENT, NOT_AFTER);
    let good_policy = || policy(TEST_KIND, &[MEASUREMENT]);
    let w = |name: &str,
             b: &Bundle,
             pol: Value,
             now: i64,
             requires: bool,
             status: &str,
             reasons: &[&str]| {
        write_attested(dir, name, b, a, pol, now, requires, status, reasons)
    };
    let valid = attested(TEST_KIND, MEASUREMENT, Some(good_doc()), s);

    w(
        "attested_valid",
        &valid,
        good_policy(),
        NOW,
        true,
        "valid",
        &[],
    );
    w(
        "attested_measurement_not_allowed",
        &valid,
        policy(TEST_KIND, &["0011223344556677"]),
        NOW,
        true,
        "invalid",
        &["ATTESTATION_MEASUREMENT"],
    );
    // The document binds an address one byte off the header's runtime key.
    let mut near = a.0;
    near.0[19] ^= 1;
    w(
        "attested_key_mismatch",
        &attested(
            TEST_KIND,
            MEASUREMENT,
            Some(doc(Address::from(near), MEASUREMENT, NOT_AFTER)),
            s,
        ),
        good_policy(),
        NOW,
        true,
        "invalid",
        &["ATTESTATION_KEY_MISMATCH"],
    );
    // A genuine document, but issued for another runtime's key.
    w(
        "attested_document_for_other_key",
        &attested(
            TEST_KIND,
            MEASUREMENT,
            Some(doc(other.address(), MEASUREMENT, NOT_AFTER)),
            s,
        ),
        good_policy(),
        NOW,
        true,
        "invalid",
        &["ATTESTATION_KEY_MISMATCH"],
    );
    w(
        "attested_missing_document",
        &attested(TEST_KIND, MEASUREMENT, None, s),
        good_policy(),
        NOW,
        true,
        "invalid",
        &["ATTESTATION_INVALID"],
    );
    let mut tampered: Value = serde_json::from_slice(&good_doc()).unwrap();
    tampered["not_after"] = json!(NOT_AFTER + 1);
    w(
        "attested_tampered_document",
        &attested(
            TEST_KIND,
            MEASUREMENT,
            Some(serde_json::to_vec(&tampered).unwrap()),
            s,
        ),
        good_policy(),
        NOW,
        true,
        "invalid",
        &["ATTESTATION_INVALID"],
    );
    w(
        "attested_expired",
        &attested(
            TEST_KIND,
            MEASUREMENT,
            Some(doc(a, MEASUREMENT, NOW - 1)),
            s,
        ),
        good_policy(),
        NOW,
        true,
        "invalid",
        &["ATTESTATION_INVALID"],
    );
    w(
        "attested_empty_policy",
        &valid,
        json!({}),
        NOW,
        true,
        "invalid",
        &["ATTESTATION_INVALID"],
    );

    // Header-shape vectors: nothing here depends on the test kind being compiled in.
    let with_doc = forge_raw(minimal(s), |b| {
        b.receipt.attestation_document = Some(Bytes::from(good_doc()));
    });
    w(
        "unattested_with_document",
        &with_doc,
        good_policy(),
        NOW,
        false,
        "invalid",
        &["ATTESTATION_UNSUPPORTED", "UNATTESTED"],
    );
    let under_v0 = forge(
        valid.clone(),
        |b| {
            b.receipt.header.version = VERSION.into();
            recommit(b);
        },
        s,
        &d,
    );
    w(
        "attested_under_v0",
        &under_v0,
        good_policy(),
        NOW,
        false,
        "invalid",
        &["ATTESTATION_UNSUPPORTED"],
    );
    w(
        "attested_unknown_kind",
        &attested("unknown-kind", MEASUREMENT, Some(good_doc()), s),
        policy("unknown-kind", &[MEASUREMENT]),
        NOW,
        false,
        "invalid",
        &["ATTESTATION_UNSUPPORTED"],
    );
}

fn main() {
    let dir = std::env::args().nth(1).expect("usage: gen_vectors <dir>");
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).unwrap();
    let s: PrivateKeySigner = KEY.parse().unwrap();
    let other: PrivateKeySigner = OTHER_KEY.parse().unwrap();
    let d = receipt_domain(CHAIN_ID, registry());
    let a = s.address();
    let base = three_steps(&s);
    let ok = "unattested_valid";
    let bad = "invalid";

    write(
        dir,
        "valid_minimal",
        &minimal(&s),
        a,
        None,
        ok,
        &["UNATTESTED"],
    );
    write(
        dir,
        "valid_three_steps",
        &base,
        a,
        None,
        ok,
        &["UNATTESTED"],
    );

    let forged = |edit: &dyn Fn(&mut Bundle)| forge(base.clone(), |b| edit(b), &s, &d);
    write(
        dir,
        "seq_gap",
        &forged(&|b| {
            b.receipt.steps[2].seq = 5;
            b.receipt.evidence = vec![2, 5];
            recommit(b);
        }),
        a,
        None,
        bad,
        &["SEQ_GAP"],
    );
    write(
        dir,
        "seq_order",
        &forged(&|b| {
            b.receipt.steps.swap(0, 1);
            recommit(b);
        }),
        a,
        None,
        bad,
        &["SEQ_ORDER"],
    );
    write(
        dir,
        "chain_mismatch",
        &forged(&|b| b.receipt.terminal_hash = keccak256(b"x")),
        a,
        None,
        bad,
        &["CHAIN_MISMATCH"],
    );
    write(
        dir,
        "root_mismatch",
        &forged(&|b| b.receipt.root = keccak256(b"x")),
        a,
        None,
        bad,
        &["ROOT_MISMATCH"],
    );
    write(
        dir,
        "body_hash_mismatch",
        &resign(
            forge_raw(base.clone(), |b| b.receipt.body_hash = keccak256(b"x")),
            &s,
            &d,
        ),
        a,
        None,
        bad,
        &["BODY_HASH_MISMATCH"],
    );
    write(
        dir,
        "bad_signature",
        &forge(base.clone(), |_| {}, &other, &d),
        a,
        None,
        bad,
        &["BAD_SIGNATURE"],
    );
    write(
        dir,
        "phi_hash_mismatch",
        &forged(&|b| {
            b.receipt.header.phi_hash = keccak256(b"another predicate");
            recommit(b);
        }),
        a,
        None,
        bad,
        &["PHI_HASH_MISMATCH"],
    );
    write(
        dir,
        "no_phi_eval",
        &forged(&|b| {
            b.receipt.steps.pop();
            b.receipt.evidence = vec![2];
            recommit(b);
        }),
        a,
        None,
        bad,
        &["NO_PHI_EVAL"],
    );
    write(
        dir,
        "phi_eval_not_last",
        &forged(&|b| {
            b.receipt.steps.swap(1, 2);
            b.receipt.steps[1].seq = 2;
            b.receipt.steps[2].seq = 3;
            b.receipt.evidence = vec![2, 3];
            recommit(b);
        }),
        a,
        None,
        bad,
        &["PHI_EVAL_NOT_LAST"],
    );
    write(
        dir,
        "phi_eval_not_evidence",
        &forged(&|b| b.receipt.evidence = vec![2]),
        a,
        None,
        bad,
        &["PHI_EVAL_NOT_EVIDENCE"],
    );
    write(
        dir,
        "meter_mismatch",
        &forged(&|b| b.receipt.meter.usd_micros += 1),
        a,
        None,
        bad,
        &["METER_MISMATCH"],
    );
    write(
        dir,
        "blob_missing",
        &forged(&|b| {
            let d = b.receipt.steps[1].output_digest;
            b.blobs.remove(&d);
        }),
        a,
        None,
        bad,
        &["BLOB_MISSING"],
    );
    write(
        dir,
        "blob_digest_mismatch",
        &forged(&|b| {
            let d = b.receipt.steps[1].output_digest;
            b.blobs.insert(d, STANDARD.encode(b"tampered output"));
        }),
        a,
        None,
        bad,
        &["BLOB_DIGEST_MISMATCH"],
    );
    write(
        dir,
        "phi_result_contradicted",
        &forged(&|b| {
            let mut lie = phi_result(false);
            lie.holds = true;
            let bytes = jcs_bytes(&lie);
            let digest = keccak256(&bytes);
            b.blobs.insert(digest, STANDARD.encode(&bytes));
            let last = b.receipt.steps.last_mut().unwrap();
            last.output_digest = digest;
            last.exit_status = Some(1);
            recommit(b);
        }),
        a,
        None,
        bad,
        &["PHI_RESULT_CONTRADICTED"],
    );
    write(
        dir,
        "attestation_unsupported",
        &forged(&|b| {
            b.receipt.header.attestation.kind = "tee".into();
            recommit(b);
        }),
        a,
        None,
        bad,
        &["ATTESTATION_UNSUPPORTED"],
    );
    let r = &base.receipt;
    let commitment = |root: B256| {
        json!({
            "root": root, "terminal_hash": r.terminal_hash, "body_hash": r.body_hash, "cost_micros": r.meter.usd_micros.to_string()
        })
    };
    write(
        dir,
        "valid_with_commitment",
        &base,
        a,
        Some(commitment(r.root)),
        ok,
        &["UNATTESTED"],
    );
    write(
        dir,
        "commitment_mismatch",
        &base,
        a,
        Some(commitment(keccak256(b"other root"))),
        bad,
        &["COMMITMENT_MISMATCH"],
    );

    attested_vectors(dir, &s, &other);

    let ids: Vec<Value> = [(0u32, 1u32), (2, 1), (0, 2)]
        .iter()
        .map(|&(index, attempt)| {
            let p = plan_id(PLAN_UUID);
            json!({"plan_uuid": PLAN_UUID, "index": index, "attempt": attempt, "plan_id": p, "task_id": task_id(p, index, attempt)})
        })
        .collect();
    std::fs::write(
        dir.join("ids.json"),
        serde_json::to_string_pretty(&ids).unwrap() + "\n",
    )
    .unwrap();
}
