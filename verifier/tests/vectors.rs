use alloy_primitives::{Address, B256, U256};
use mergit_spec::{Bundle, receipt_domain};
use mergit_verifier::{Commitment, Status, TrustPolicy, Verifier, verify};
use serde_json::Value;

fn vectors() -> Vec<Value> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../spec/vectors");
    let mut out: Vec<Value> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap() != "ids.json")
        .map(|p| serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap())
        .collect();
    out.sort_by_key(|v| v["name"].as_str().unwrap().to_string());
    out
}

fn commitment(v: &Value) -> Option<Commitment> {
    if v.is_null() {
        return None;
    }
    let h = |k: &str| v[k].as_str().unwrap().parse::<B256>().unwrap();
    Some(Commitment {
        root: h("root"),
        terminal_hash: h("terminal_hash"),
        body_hash: h("body_hash"),
        cost_micros: v["cost_micros"].as_str().unwrap().parse::<U256>().unwrap(),
    })
}

#[test]
fn every_vector_verifies_as_expected() {
    let all = vectors();
    assert!(
        all.len() >= 30,
        "expected at least 30 vectors, found {}",
        all.len()
    );
    for v in all {
        let name = v["name"].as_str().unwrap();
        let bundle: Bundle = serde_json::from_value(v["bundle"].clone()).unwrap();
        let domain = receipt_domain(
            v["domain"]["chain_id"].as_u64().unwrap(),
            v["domain"]["registry"].as_str().unwrap().parse().unwrap(),
        );
        let signer: Address = v["signer"].as_str().unwrap().parse().unwrap();
        // Optional: absent means an empty policy and now = 0, as for the v0 vectors.
        let policy: TrustPolicy = match v.get("policy") {
            Some(p) => serde_json::from_value(p.clone()).unwrap(),
            None => TrustPolicy::default(),
        };
        let now = v.get("now").map_or(0, |n| n.as_i64().unwrap());
        let report = Verifier::new(policy).verify(
            &bundle,
            &domain,
            Some(signer),
            commitment(&v["commitment"]).as_ref(),
            now,
        );
        // A vector that needs the test kind cannot be verified as designed without it. With the feature off the
        // kind is not registered, so it must be invalid for exactly that reason and no other.
        if v.get("requires").and_then(Value::as_str) == Some("test-attestation")
            && !cfg!(feature = "test-attestation")
        {
            let got = serde_json::to_value(&report).unwrap();
            assert_eq!(got["status"], "invalid", "{name}: {got}");
            assert_eq!(
                got["reasons"],
                serde_json::json!(["ATTESTATION_UNSUPPORTED"]),
                "{name}: {got}"
            );
            continue;
        }
        let got = serde_json::to_value(&report).unwrap();
        assert_eq!(got["status"], v["expect"]["status"], "{name}: {got}");
        let reasons: Vec<&str> = got["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_str().unwrap())
            .collect();
        let want: Vec<&str> = v["expect"]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_str().unwrap())
            .collect();
        for w in &want {
            assert!(reasons.contains(w), "{name}: missing {w} in {reasons:?}");
        }
        if v["expect"]["status"] == "invalid" {
            // A forged vector breaks one rule; any other reason means the vector or the verifier is wrong.
            let extra: Vec<_> = reasons
                .iter()
                .filter(|r| !want.contains(r) && **r != "UNATTESTED")
                .collect();
            assert!(extra.is_empty(), "{name}: unexpected reasons {extra:?}");
        }
    }
}

#[test]
fn unattested_receipt_is_never_reported_valid_attested() {
    for v in vectors() {
        let bundle: Bundle = serde_json::from_value(v["bundle"].clone()).unwrap();
        let domain = receipt_domain(84532, Address::with_last_byte(1));
        let report = verify(&bundle, &domain, None, None);
        assert!(matches!(
            report.status,
            Status::UnattestedValid | Status::Invalid
        ));
    }
}

#[test]
fn honest_vector_reports_phi_holds() {
    let v = vectors()
        .into_iter()
        .find(|v| v["name"] == "valid_three_steps")
        .unwrap();
    let bundle: Bundle = serde_json::from_value(v["bundle"].clone()).unwrap();
    let report = verify(
        &bundle,
        &receipt_domain(84532, Address::with_last_byte(1)),
        None,
        None,
    );
    assert_eq!(report.phi_holds, Some(true));
}
