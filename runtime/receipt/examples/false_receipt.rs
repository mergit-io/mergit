//! Builds a deliberately false receipt for the end-to-end check in deploy/e2e/false_receipt.md: Φ failed
//! (exit 1) but the recorded result claims it held. It is signed with the agent's real runtime key, the way a
//! dishonest operator would sign it, so only the evidence check can catch it (PHI_RESULT_CONTRADICTED).
//!
//! cargo run -p mergit-receipt --features forgery-fixture --example false_receipt -- \
//!   --task <task_id> --plan <plan_id> --agent <agent_id> --requester <address> \
//!   --key <runtime key hex> --chain-id 84532 --registry <ReceiptRegistry address> --out <dir>
//!
//! Writes <dir>/bundle.json (PUT it to the store) and <dir>/receipt-sealed.json (POST it to the gateway).

use alloy_primitives::{Address, B256, keccak256};
use alloy_signer_local::PrivateKeySigner;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use mergit_receipt::ReceiptBuilder;
use mergit_receipt::fixture::forge;
use mergit_spec::*;
use serde_json::json;

fn arg(name: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| panic!("missing {name}"))
}

fn main() {
    let task: B256 = arg("--task").parse().expect("--task is a 32-byte hex id");
    let plan: B256 = arg("--plan").parse().expect("--plan is a 32-byte hex id");
    let signer: PrivateKeySigner = arg("--key").parse().expect("--key is a private key");
    let registry: Address = arg("--registry").parse().expect("--registry is an address");
    let domain = receipt_domain(
        arg("--chain-id").parse().expect("--chain-id is a number"),
        registry,
    );
    let out = std::path::PathBuf::from(arg("--out"));

    let phi = Predicate {
        kind: PREDICATE_KIND.into(),
        command: vec!["pytest".into(), "-q".into()],
        expected_exit: 0,
        workdir: ".".into(),
        allowed_paths: None,
        artifact_hashes: None,
        timeout_s: 600,
    };
    let header = Header {
        version: VERSION.into(),
        task_id: task,
        plan_id: plan,
        requester: arg("--requester")
            .parse()
            .expect("--requester is an address"),
        agent_id: arg("--agent"),
        category: "test-repair".into(),
        phi_hash: jcs_hash(&phi),
        phi,
        budget_usdc_units: "1000000".into(),
        runtime_image: "false-receipt-check".into(),
        attestation: Attestation::unattested(signer.address()),
        started_at: fmt_time(Utc::now()),
    };
    let honest_fail = PhiResult {
        exit_code: 1,
        changed_paths: vec![],
        observed_artifact_hashes: Default::default(),
        stdout_digest: keccak256(b"1 failed"),
        holds: false,
    };
    let honest = ReceiptBuilder::new(header)
        .unwrap()
        .seal_with_phi(
            honest_fail.clone(),
            Cost::default(),
            Utc::now(),
            &signer,
            &domain,
        )
        .unwrap();

    let bundle = forge(
        honest,
        |b| {
            let mut lie = honest_fail;
            lie.holds = true;
            let bytes = jcs_bytes(&lie);
            let digest = keccak256(&bytes);
            b.blobs.insert(digest, STANDARD.encode(&bytes));
            b.receipt.steps.last_mut().unwrap().output_digest = digest;
            let leaves: Vec<B256> = b.receipt.steps.iter().map(leaf).collect();
            b.receipt.root = merkle_root(&leaves);
            b.receipt.terminal_hash = chain(jcs_hash(&b.receipt.header), &leaves);
        },
        &signer,
        &domain,
    );

    let r = &bundle.receipt;
    let event = json!({
        "event_id": uuid_v4(),
        "type": "receipt.sealed",
        "at": fmt_time(Utc::now()),
        "payload": {
            "task_id": r.header.task_id, "agent_id": r.header.agent_id, "root": r.root, "terminal_hash": r.terminal_hash,
            "body_hash": r.body_hash, "cost_micros": r.meter.usd_micros, "signature": r.signature
        }
    });
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(
        out.join("bundle.json"),
        serde_json::to_string(&bundle).unwrap(),
    )
    .unwrap();
    std::fs::write(
        out.join("receipt-sealed.json"),
        serde_json::to_string_pretty(&event).unwrap(),
    )
    .unwrap();
    println!(
        "wrote {}/bundle.json and {}/receipt-sealed.json",
        out.display(),
        out.display()
    );
}

/// A random v4 UUID without another dependency.
fn uuid_v4() -> String {
    let b = keccak256(
        Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_default()
            .to_be_bytes(),
    );
    let h = alloy_primitives::hex::encode(&b[..16]);
    format!(
        "{}-{}-4{}-a{}-{}",
        &h[0..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32]
    )
}
