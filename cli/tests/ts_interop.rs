//! Cross-implementation check of OEM signing against the TypeScript core
//! (`packages/core/src/sign/index.ts`), by actually running it under Node.
//!
//! Needs `node` and a built core (`pnpm --filter @open-firmware/core build`).
//! When either is absent the test is skipped with a note; set
//! `OFW_REQUIRE_TS_INTEROP=1` to make that a failure instead.
//! `OFW_TS_SIGN_JS=/path/to/dist/sign/index.js` selects a different build.

mod common;

use common::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;

/// Same fixed vector as `sign::test_vectors` in the crate.
const VECTOR_SIG: &str =
    "up8_IsTc9HBAZIljbb_WYPe0VGd_ulwNUswGwT5IMT3twPHtZoFxWSBJBK7o12NvkA0FlHJ0Rfrj09ydtHGtBw";

const SCRIPT: &str = r#"
import { pathToFileURL } from 'node:url'
const sign = await import(pathToFileURL(process.env.SIGN_JS).href)
const input = JSON.parse(process.env.INPUT)
const out = {}
if (input.generate) out.generated = sign.generateOemKey()
if (input.sign) {
  out.signed = sign.signRelease(input.sign.pem, input.sign.fields, input.sign.publicKey, input.sign.keyId)
}
if (input.verify) {
  out.verified = sign.verifyOemSignature(input.verify.release, input.verify.trusted)
  out.verifiedOtherKey = sign.verifyOemSignature(input.verify.release, [input.verify.otherKey])
  out.verifiedTampered = sign.verifyOemSignature(
    { ...input.verify.release, imageSize: input.verify.release.imageSize + 1 }, input.verify.trusted)
}
console.log(JSON.stringify(out))
"#;

fn sign_js() -> Option<PathBuf> {
    // OFW_TS_SIGN_JS points the test at another build of the core package.
    let js = std::env::var_os("OFW_TS_SIGN_JS")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/core/dist/sign/index.js")
        });
    let node_ok = Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if js.is_file() && node_ok {
        return Some(js);
    }
    let why = format!(
        "TypeScript interop not checked: node available={node_ok}, {} exists={}",
        js.display(),
        js.is_file()
    );
    if std::env::var("OFW_REQUIRE_TS_INTEROP").is_ok_and(|v| v == "1") {
        panic!("{why}");
    }
    eprintln!("SKIPPED: {why}");
    None
}

fn node(js: &PathBuf, input: Value) -> Value {
    let out = Command::new("node")
        .args(["--input-type=module", "-e", SCRIPT])
        .env("SIGN_JS", js)
        .env("INPUT", input.to_string())
        .output()
        .expect("run node");
    assert!(
        out.status.success(),
        "node failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("node output is JSON")
}

/// Publish with `ofw --oem-key`, return the stored release record.
fn publish_signed(pds: &MockPds, pem: &str, name: &str) -> Value {
    let key = temp_file(&format!("{name}.pem"), pem.as_bytes());
    let file = temp_file(&format!("{name}.bin"), &payload(300));
    pds.publisher(&[
        "publish",
        "--product",
        "cam",
        "--version",
        "1.2.3",
        "--file",
        file.to_str().unwrap(),
        "--oem-key",
        key.to_str().unwrap(),
        "--oem-key-id",
        "factory-1",
        "--yes",
        "--json",
    ])
    .ok();
    pds.state()
        .get(PUBLISHER_DID, RELEASE, "cam-1.2.3-stable")
        .cloned()
        .unwrap()
}

fn fields(release: &Value) -> Value {
    json!({
        "product": release["product"], "version": release["version"],
        "channel": release["channel"], "imageSha256": release["imageSha256"],
        "imageSize": release["imageSize"],
    })
}

#[test]
fn fixed_vector_matches_typescript_sign_release() {
    let Some(js) = sign_js() else { return };
    let out = node(
        &js,
        json!({ "sign": {
            "pem": OEM_PEM, "publicKey": OEM_PUBLIC, "keyId": "factory-1",
            "fields": { "product": "cam", "version": "1.2.3", "channel": "stable",
                        "imageSha256": "ab".repeat(32), "imageSize": 99 },
        }}),
    );
    assert_eq!(
        out["signed"],
        json!({ "alg": "ed25519", "publicKey": OEM_PUBLIC, "sig": VECTOR_SIG, "keyId": "factory-1" }),
        "the vector hard-coded in src/sign.rs must be what TypeScript produces"
    );
}

#[test]
fn typescript_verifies_what_ofw_signs_and_signs_identically() {
    let Some(js) = sign_js() else { return };
    let pds = MockPds::start();
    let release = publish_signed(&pds, OEM_PEM, "rfc");
    let sig = &release["oemSignature"];
    assert_eq!(sig["publicKey"], OEM_PUBLIC);

    let mut ts_release = fields(&release);
    ts_release["oemSignature"] = sig.clone();
    let out = node(
        &js,
        json!({
            "verify": { "release": ts_release, "trusted": [OEM_PUBLIC],
                        "otherKey": "A".repeat(43) },
            "sign": { "pem": OEM_PEM, "publicKey": OEM_PUBLIC, "keyId": "factory-1",
                      "fields": fields(&release) },
        }),
    );
    assert_eq!(
        out["verified"],
        json!({ "ok": true }),
        "TS must accept ofw's signature"
    );
    assert_eq!(out["verifiedOtherKey"]["ok"], false);
    assert_eq!(out["verifiedTampered"]["ok"], false);
    // Ed25519 is deterministic: both implementations emit the same record field.
    assert_eq!(&out["signed"], sig);
}

#[test]
fn ofw_accepts_a_typescript_generated_key_and_its_signature() {
    let Some(js) = sign_js() else { return };
    let generated = node(&js, json!({ "generate": true }))["generated"].clone();
    let pem = generated["privateKeyPem"].as_str().unwrap();
    let public = generated["publicKey"].as_str().unwrap();

    // ofw loads the PEM that TypeScript wrote...
    let pds = MockPds::start();
    let release = publish_signed(&pds, pem, "tsgen");
    assert_eq!(release["oemSignature"]["publicKey"], public);

    // ...then the record's signature is replaced by the one TypeScript makes,
    // and `ofw audit` verifies it against the pinned key.
    let ts = node(
        &js,
        json!({ "sign": { "pem": pem, "publicKey": public, "fields": fields(&release) } }),
    );
    let mut swapped = release.clone();
    swapped["oemSignature"] = ts["signed"].clone();
    let cid = cid_of(&swapped);
    {
        let mut st = pds.state();
        *st.get_mut(PUBLISHER_DID, RELEASE, "cam-1.2.3-stable")
            .unwrap() = swapped;
        st.get_mut(PUBLISHER_DID, GATE, "cam-1.2.3-stable").unwrap()["release"]["cid"] = json!(cid);
    }
    let audit = |key: &str| {
        pds.anonymous(&[
            "audit",
            "--repo",
            PUBLISHER_DID,
            "--rkey",
            "cam-1.2.3-stable",
            "--trusted-oem-key",
            key,
            "--json",
        ])
    };
    let a = audit(public).ok().json();
    assert_eq!(a["oemSignature"]["status"], "trusted");
    assert_eq!(audit(OEM_PUBLIC).code, 2);
}
