use alloy_primitives::{Address, Bytes};
use mergit_spec::{Attestation, Bundle, Header, VERSION, VERSION_V1, body_hash};

fn addr(b: u8) -> Address {
    Address::repeat_byte(b)
}

fn vector_bundle() -> (serde_json::Value, Bundle) {
    let raw = include_str!("../vectors/valid_minimal.json");
    let v: serde_json::Value = serde_json::from_str(raw).unwrap();
    let bundle: Bundle = serde_json::from_value(v["bundle"].clone()).unwrap();
    (v, bundle)
}

#[test]
fn versions() {
    assert_eq!(VERSION, "mergit-receipt/0");
    assert_eq!(VERSION_V1, "mergit-receipt/1");
}

#[test]
fn unattested_json_is_unchanged() {
    let a = addr(0xab);
    assert_eq!(
        serde_json::to_string(&Attestation::unattested(a)).unwrap(),
        format!(r#"{{"kind":"unattested","dev_key":"{a:#x}"}}"#)
    );
    let (v, bundle) = vector_bundle();
    let h = &bundle.receipt.header;
    let again: Header = serde_json::from_value(serde_json::to_value(h).unwrap()).unwrap();
    assert_eq!(&again, h);
    assert_eq!(
        serde_json::to_value(h).unwrap(),
        v["bundle"]["receipt"]["header"]
    );
    assert_eq!(
        serde_json::to_value(&bundle.receipt).unwrap(),
        v["bundle"]["receipt"]
    );
}

#[test]
fn attested_round_trips() {
    let a = addr(0x11);
    let att = Attestation::attested("test-ed25519", a, "ab12");
    assert_eq!(
        serde_json::to_string(&att).unwrap(),
        format!(r#"{{"kind":"test-ed25519","runtime_key":"{a:#x}","measurement":"ab12"}}"#)
    );
    assert_eq!(att.signing_key(), Some(a));
    let back: Attestation = serde_json::from_str(&serde_json::to_string(&att).unwrap()).unwrap();
    assert_eq!(back, att);
    assert_eq!(Attestation::unattested(a).signing_key(), Some(a));
}

#[test]
fn body_hash_ignores_document() {
    let (_, bundle) = vector_bundle();
    let mut r = bundle.receipt;
    let without = body_hash(&r);
    r.attestation_document = Some(Bytes::from_static(b"x"));
    assert_eq!(body_hash(&r), without);
}

#[test]
fn unknown_field_rejected() {
    let j =
        r#"{"kind":"unattested","dev_key":"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","extra":1}"#;
    assert!(serde_json::from_str::<Attestation>(j).is_err());
}
