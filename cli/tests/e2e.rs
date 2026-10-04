//! End-to-end tests: the real `ofw` binary against an in-process mock PDS.

mod common;

use common::*;
use serde_json::{json, Value};

const RKEY: &str = "cam-1.0.0-stable";

fn publish_args<'a>(file: &'a str, version: &'a str) -> Vec<&'a str> {
    vec![
        "publish",
        "--product",
        "cam",
        "--version",
        version,
        "--file",
        file,
        "--chunk-size",
        "100",
        "--yes",
        "--json",
    ]
}

/// Publish cam <version> (250 bytes, 3 parts) with extra flags.
fn publish(pds: &MockPds, version: &str, extra: &[&str]) -> Run {
    let file = temp_file(&format!("cam-{version}.bin"), &payload(250));
    let file = file.to_str().unwrap().to_string();
    let mut args = publish_args(&file, version);
    args.extend_from_slice(extra);
    pds.publisher(&args)
}

fn gate_state(pds: &MockPds, rkey: &str) -> Option<String> {
    pds.state()
        .get(PUBLISHER_DID, GATE, rkey)
        .map(|g| g["state"].as_str().unwrap().to_string())
}

fn channel_version(pds: &MockPds) -> Option<String> {
    pds.state()
        .get(PUBLISHER_DID, CHANNEL, "cam-stable")
        .map(|c| c["version"].as_str().unwrap().to_string())
}

fn audit(pds: &MockPds, extra: &[&str]) -> Run {
    let mut args = vec!["audit", "--repo", PUBLISHER_DID, "--rkey", RKEY, "--json"];
    args.extend_from_slice(extra);
    pds.anonymous(&args)
}

#[test]
fn publish_ack_promote_audit_with_independent_ci_and_oem_signature() {
    let pds = MockPds::start();
    let key = temp_file("oem.pem", OEM_PEM.as_bytes());

    let out = publish(
        &pds,
        "1.0.0",
        &[
            "--require-pipeline",
            "--stages",
            "build,test",
            "--oem-key",
            key.to_str().unwrap(),
            "--oem-key-id",
            "factory-1",
        ],
    )
    .ok()
    .json();
    assert_eq!(out["rkey"], RKEY);
    assert_eq!(out["gate"], "awaiting-pipeline");
    assert_eq!(out["partCount"], 3);
    assert_eq!(out["oemSigned"], true);
    assert_eq!(out["oemPublicKey"], OEM_PUBLIC);
    assert_eq!(out["channelUpdated"], false);
    assert_eq!(out["warnings"], json!([]));
    {
        let st = pds.state();
        let rel = st.get(PUBLISHER_DID, RELEASE, RKEY).unwrap();
        assert_eq!(rel["oemSignature"]["alg"], "ed25519");
        assert_eq!(rel["oemSignature"]["keyId"], "factory-1");
        assert_eq!(rel["requiredPipelineStages"], json!(["build", "test"]));
        assert!(
            st.get(PUBLISHER_DID, CHANNEL, "cam-stable").is_none(),
            "channel must not move before promotion"
        );
    }

    // Not installable yet.
    let a = audit(&pds, &[]);
    assert_eq!(a.code, 2);
    assert_eq!(a.issue_codes(), ["INCOMPLETE_PUBLISH"]);

    // CI (a different account) acks build in its own repo.
    let ack = pds
        .ci(&[
            "pipeline-ack",
            "--rkey",
            RKEY,
            "--author-did",
            PUBLISHER_DID,
            "--stage",
            "build",
            "--result",
            "passed",
            "--json",
        ])
        .ok()
        .json();
    assert_eq!(ack["promoted"], false);
    assert_eq!(ack["promotion"], "not-attempted");
    assert_eq!(ack["gate"], Value::Null);
    assert_eq!(ack["releaseCid"], out["cid"]);
    assert_eq!(pds.state().count(CI_DID, ACK), 1);

    // Publisher cannot promote yet: `test` is missing.
    pds.publisher(&["pipeline-promote", "--rkey", RKEY, "--attester-did", CI_DID])
        .fails_with(1, "missing: test");
    // ...and CI's acks do not count for a self-attested promotion either.
    pds.publisher(&["pipeline-promote", "--rkey", RKEY])
        .fails_with(1, "self-attested");
    assert_eq!(gate_state(&pds, RKEY).as_deref(), Some("awaiting-pipeline"));

    pds.ci(&[
        "pipeline-ack",
        "--rkey",
        RKEY,
        "--author-did",
        PUBLISHER_DID,
        "--stage",
        "test",
        "--result",
        "passed",
    ])
    .ok();

    let promoted = pds
        .publisher(&[
            "pipeline-promote",
            "--rkey",
            RKEY,
            "--attester-did",
            CI_DID,
            "--json",
        ])
        .ok()
        .json();
    assert_eq!(promoted["promoted"], true);
    assert_eq!(promoted["gate"], "ready");
    assert_eq!(promoted["selfAttested"], false);
    assert_eq!(promoted["attesterDids"], json!([CI_DID]));
    assert_eq!(gate_state(&pds, RKEY).as_deref(), Some("ready"));
    assert_eq!(channel_version(&pds).as_deref(), Some("1.0.0"));

    // Audit by *handle*, with blob probe and the pinned OEM key.
    let a = pds
        .anonymous(&[
            "audit",
            "--repo",
            PUBLISHER_HANDLE,
            "--rkey",
            RKEY,
            "--probe-blobs",
            "--trusted-oem-key",
            OEM_PUBLIC,
            "--json",
        ])
        .ok()
        .json();
    assert_eq!(a["ok"], true);
    assert_eq!(a["authorDid"], PUBLISHER_DID);
    assert_eq!(a["gate"], "ready");
    assert_eq!(a["blobsProbed"], true);
    assert_eq!(a["declaredPartCount"], 3);
    assert_eq!(a["oemSignature"]["status"], "trusted");

    // Without a pinned key the signature is reported but explicitly unpinned.
    let a = audit(&pds, &[]).ok().json();
    assert_eq!(a["oemSignature"]["status"], "unpinned");

    // A different pinned key: the release is refused.
    let other = "A".repeat(43);
    let a = audit(&pds, &["--trusted-oem-key", &other]);
    assert_eq!(a.code, 2);
    assert_eq!(a.issue_codes(), ["OEM_SIG_INVALID"]);

    // Tampering with a signed field breaks the signature even when unpinned.
    pds.state().get_mut(PUBLISHER_DID, RELEASE, RKEY).unwrap()["oemSignature"]["sig"] =
        json!("A".repeat(86));
    let a = audit(&pds, &[]);
    assert_eq!(a.code, 2);
    assert!(a.issue_codes().contains(&"OEM_SIG_INVALID".to_string()));
}

#[test]
fn unsigned_release_fails_audit_when_a_key_is_pinned() {
    let pds = MockPds::start();
    publish(&pds, "1.0.0", &[]).ok();
    let a = audit(&pds, &[]).ok().json();
    assert_eq!(a["oemSignature"]["status"], "missing");
    let a = audit(&pds, &["--trusted-oem-key", OEM_PUBLIC]);
    assert_eq!(a.code, 2);
    assert_eq!(a.issue_codes(), ["OEM_SIG_MISSING"]);
    // A malformed pinned key is a usage error, not "untrusted".
    audit(&pds, &["--trusted-oem-key", "not-a-key"]).fails_with(1, "trusted OEM key");
}

#[test]
fn default_publish_is_ready_and_releases_are_create_only() {
    let pds = MockPds::start();
    let out = publish(&pds, "1.0.0", &[]).ok().json();
    assert_eq!(out["gate"], "ready");
    assert_eq!(out["channelUpdated"], true);
    assert_eq!(out["oemSigned"], false);
    assert_eq!(gate_state(&pds, RKEY).as_deref(), Some("ready"));
    assert_eq!(channel_version(&pds).as_deref(), Some("1.0.0"));
    {
        let st = pds.state();
        assert_eq!(st.count(PUBLISHER_DID, SEAL), 1);
        assert_eq!(
            st.get(PUBLISHER_DID, DECLARATION, "self").unwrap()["products"],
            json!(["cam"])
        );
        assert_eq!(st.blobs.len(), 3);
    }
    audit(&pds, &["--probe-blobs"]).ok();

    // Re-publishing the same version (different bytes) must not replace it.
    let before = pds.state().get(PUBLISHER_DID, RELEASE, RKEY).cloned();
    let writes = pds.state().writes();
    let other = temp_file("other.bin", &payload(99));
    pds.publisher(&publish_args(other.to_str().unwrap(), "1.0.0"))
        .fails_with(1, "already exists");
    assert_eq!(
        pds.state().get(PUBLISHER_DID, RELEASE, RKEY).cloned(),
        before
    );
    assert_eq!(pds.state().writes(), writes, "nothing may be written");
    assert!(!pds
        .state()
        .log
        .iter()
        .any(|l| l.contains("putRecord") && l.contains(RELEASE)));
}

#[test]
fn existence_check_does_not_treat_server_errors_as_not_found() {
    let pds = MockPds::start();
    publish(&pds, "1.0.0", &[]).ok();
    let before = pds.state().get(PUBLISHER_DID, RELEASE, RKEY).cloned();
    // getRecord for the release now answers 500: publish must stop, not create.
    pds.fail("com.atproto.repo.getRecord", RELEASE);
    let writes = pds.state().writes();
    publish(&pds, "1.0.0", &[]).fails_with(1, "HTTP 500");
    assert_eq!(pds.state().writes(), writes);
    assert_eq!(
        pds.state().get(PUBLISHER_DID, RELEASE, RKEY).cloned(),
        before
    );
}

#[test]
fn channel_downgrade_needs_an_explicit_flag() {
    let pds = MockPds::start();
    publish(&pds, "2.0.0", &[]).ok();
    let writes = pds.state().writes();
    publish(&pds, "1.0.0", &[]).fails_with(1, "--allow-downgrade");
    assert_eq!(pds.state().writes(), writes, "refused before any upload");
    assert_eq!(channel_version(&pds).as_deref(), Some("2.0.0"));

    publish(&pds, "1.0.0", &["--allow-downgrade"]).ok();
    assert_eq!(channel_version(&pds).as_deref(), Some("1.0.0"));

    // Promotion path: an older gated release cannot take the channel back.
    publish(&pds, "3.0.0", &[]).ok();
    publish(&pds, "2.5.0", &["--require-pipeline", "--stages", "build"]).ok();
    let ack = pds
        .publisher(&[
            "pipeline-ack",
            "--rkey",
            "cam-2.5.0-stable",
            "--stage",
            "build",
            "--result",
            "passed",
            "--json",
        ])
        .ok();
    let j = ack.json();
    assert_eq!(j["promoted"], false);
    assert_eq!(j["promotion"], "refused");
    assert!(ack.stderr.contains("NOT promoted"));
    assert_eq!(
        gate_state(&pds, "cam-2.5.0-stable").as_deref(),
        Some("awaiting-pipeline"),
        "gate must not flip when the channel move is refused"
    );
    assert_eq!(channel_version(&pds).as_deref(), Some("3.0.0"));
    pds.publisher(&["pipeline-promote", "--rkey", "cam-2.5.0-stable"])
        .fails_with(1, "--allow-downgrade");
    pds.publisher(&[
        "pipeline-promote",
        "--rkey",
        "cam-2.5.0-stable",
        "--allow-downgrade",
    ])
    .ok();
    assert_eq!(channel_version(&pds).as_deref(), Some("2.5.0"));
}

#[test]
fn self_attested_pipeline_is_flagged() {
    let pds = MockPds::start();
    publish(&pds, "1.0.0", &["--require-pipeline"]).ok();
    let first = pds
        .publisher(&[
            "pipeline-ack",
            "--rkey",
            RKEY,
            "--stage",
            "build",
            "--result",
            "passed",
            "--json",
        ])
        .ok();
    let j = first.json();
    assert_eq!(j["promoted"], false, "one of two stages is not a promotion");
    assert_eq!(j["promotion"], "waiting");
    assert_eq!(j["missingStages"], json!(["test"]));
    assert_eq!(gate_state(&pds, RKEY).as_deref(), Some("awaiting-pipeline"));

    let second = pds
        .publisher(&[
            "pipeline-ack",
            "--rkey",
            RKEY,
            "--stage",
            "test",
            "--result",
            "passed",
            "--json",
        ])
        .ok();
    let j = second.json();
    assert_eq!(j["promoted"], true);
    assert_eq!(j["gate"], "ready");
    assert_eq!(j["selfAttested"], true);
    assert!(second.stderr.contains("WARNING") && second.stderr.contains("self-attested"));
    assert_eq!(
        pds.state().get(PUBLISHER_DID, GATE, RKEY).unwrap()["reason"],
        "promoted on self-attested acks"
    );
    assert_eq!(channel_version(&pds).as_deref(), Some("1.0.0"));

    // Naming yourself as the attester does not make it independent.
    let j = pds
        .publisher(&[
            "pipeline-promote",
            "--rkey",
            RKEY,
            "--attester-did",
            PUBLISHER_DID,
            "--json",
        ])
        .ok()
        .json();
    assert_eq!(j["selfAttested"], true);
}

#[test]
fn no_promote_only_records_the_ack() {
    let pds = MockPds::start();
    publish(&pds, "1.0.0", &["--require-pipeline", "--stages", "build"]).ok();
    let j = pds
        .publisher(&[
            "pipeline-ack",
            "--rkey",
            RKEY,
            "--stage",
            "build",
            "--result",
            "passed",
            "--no-promote",
            "--json",
        ])
        .ok()
        .json();
    assert_eq!(j["promoted"], false);
    assert_eq!(j["promotion"], "not-attempted");
    assert_eq!(gate_state(&pds, RKEY).as_deref(), Some("awaiting-pipeline"));
}

#[test]
fn failed_gate_is_not_re_promoted_and_skip_is_an_explicit_force() {
    let pds = MockPds::start();
    publish(&pds, "1.0.0", &["--require-pipeline", "--stages", "build"]).ok();
    let j = pds
        .publisher(&[
            "pipeline-ack",
            "--rkey",
            RKEY,
            "--stage",
            "build",
            "--result",
            "failed",
            "--json",
        ])
        .ok()
        .json();
    assert_eq!(j["gate"], "failed");
    assert_eq!(j["promoted"], false);
    assert_eq!(gate_state(&pds, RKEY).as_deref(), Some("failed"));

    // A later "passed" ack does not resurrect it.
    let j = pds
        .publisher(&[
            "pipeline-ack",
            "--rkey",
            RKEY,
            "--stage",
            "build",
            "--result",
            "passed",
            "--json",
        ])
        .ok()
        .json();
    assert_eq!(j["promoted"], false);
    assert_eq!(j["promotion"], "refused");
    pds.publisher(&["pipeline-promote", "--rkey", RKEY])
        .fails_with(1, "failed");
    pds.publisher(&["pipeline-skip", "--rkey", RKEY])
        .fails_with(1, "--override-failed");
    assert_eq!(gate_state(&pds, RKEY).as_deref(), Some("failed"));
    assert_eq!(channel_version(&pds), None);

    let j = pds
        .publisher(&[
            "pipeline-skip",
            "--rkey",
            RKEY,
            "--override-failed",
            "--json",
        ])
        .ok()
        .json();
    assert_eq!(j["gate"], "ready");
    assert_eq!(j["previousGate"], "failed");
    assert_eq!(j["forced"], true);
    assert_eq!(gate_state(&pds, RKEY).as_deref(), Some("ready"));
    assert_eq!(channel_version(&pds).as_deref(), Some("1.0.0"));
}

#[test]
fn pipeline_skip_writes_the_gate_without_acks() {
    let pds = MockPds::start();
    publish(&pds, "1.0.0", &["--require-pipeline"]).ok();
    let j = pds
        .publisher(&["pipeline-skip", "--rkey", RKEY, "--json"])
        .ok()
        .json();
    assert_eq!(j["gate"], "ready");
    assert_eq!(j["previousGate"], "awaiting-pipeline");
    let st = pds.state();
    let gate = st.get(PUBLISHER_DID, GATE, RKEY).unwrap();
    assert_eq!(gate["state"], "ready");
    assert_eq!(gate["reason"], "pipeline skipped by publisher");
    assert_eq!(
        st.get(PUBLISHER_DID, CHANNEL, "cam-stable").unwrap()["version"],
        "1.0.0"
    );
}

#[test]
fn pipeline_skip_reports_failure_when_nothing_was_written() {
    let pds = MockPds::start();
    publish(&pds, "1.0.0", &["--require-pipeline"]).ok();
    pds.fail("com.atproto.repo.putRecord", GATE);
    let r = pds.publisher(&["pipeline-skip", "--rkey", RKEY, "--json"]);
    assert_eq!(r.code, 1);
    assert!(r.stdout.is_empty(), "no success JSON: {}", r.stdout);
    assert_eq!(gate_state(&pds, RKEY).as_deref(), Some("awaiting-pipeline"));
}

#[test]
fn acks_for_a_rewritten_release_do_not_promote_it() {
    let pds = MockPds::start();
    publish(&pds, "1.0.0", &["--require-pipeline", "--stages", "build"]).ok();
    pds.ci(&[
        "pipeline-ack",
        "--rkey",
        RKEY,
        "--author-did",
        PUBLISHER_DID,
        "--stage",
        "build",
        "--result",
        "passed",
    ])
    .ok();

    // The release record is replaced under the same URI (new CID).
    pds.state().get_mut(PUBLISHER_DID, RELEASE, RKEY).unwrap()["changelog"] =
        json!("swapped after CI ran");
    pds.publisher(&["pipeline-promote", "--rkey", RKEY, "--attester-did", CI_DID])
        .fails_with(1, "rewritten");
    pds.publisher(&["pipeline-skip", "--rkey", RKEY])
        .fails_with(1, "rewritten");

    // Even with a gate that matches the new CID, the old ack does not cover it.
    let new_cid = cid_of(pds.state().get(PUBLISHER_DID, RELEASE, RKEY).unwrap());
    pds.state().get_mut(PUBLISHER_DID, GATE, RKEY).unwrap()["release"]["cid"] = json!(new_cid);
    let r = pds
        .publisher(&["pipeline-promote", "--rkey", RKEY, "--attester-did", CI_DID])
        .fails_with(1, "missing: build");
    assert!(
        r.stderr.contains("different (or no) release CID"),
        "{}",
        r.stderr
    );
    assert_eq!(gate_state(&pds, RKEY).as_deref(), Some("awaiting-pipeline"));
    assert_eq!(channel_version(&pds), None);

    // The audit also notices a gate issued for another CID.
    pds.state().get_mut(PUBLISHER_DID, GATE, RKEY).unwrap()["release"]["cid"] = json!("bafyold");
    pds.state().get_mut(PUBLISHER_DID, GATE, RKEY).unwrap()["state"] = json!("ready");
    let a = audit(&pds, &[]);
    assert_eq!(a.code, 2);
    assert_eq!(a.issue_codes(), ["GATE_MISMATCH"]);
}

#[test]
fn audit_fails_closed_on_gate_problems() {
    let pds = MockPds::start();
    publish(&pds, "1.0.0", &[]).ok();
    audit(&pds, &[]).ok();

    // Gate cannot be fetched: an error (exit 1), never "ready".
    pds.fail("com.atproto.repo.getRecord", GATE);
    let r = audit(&pds, &[]).fails_with(1, "fetch gate");
    assert!(r.stdout.is_empty());
    pds.heal();

    // Gate does not exist: reported as missing, exit 2.
    pds.state().remove(PUBLISHER_DID, GATE, RKEY);
    let a = audit(&pds, &[]);
    assert_eq!(a.code, 2);
    assert_eq!(a.json()["gate"], "missing");
    assert_eq!(a.issue_codes(), ["INCOMPLETE_PUBLISH"]);

    // Release does not exist: error.
    pds.anonymous(&[
        "audit",
        "--repo",
        PUBLISHER_DID,
        "--rkey",
        "nope-1.0.0-stable",
    ])
    .fails_with(1, "RecordNotFound");
    // Unknown handle: error.
    pds.anonymous(&["audit", "--repo", "nobody.test", "--rkey", RKEY])
        .fails_with(1, "resolve handle");
}

#[test]
fn audit_detects_truncated_parts_and_hostile_numbers() {
    let pds = MockPds::start();
    publish(&pds, "1.0.0", &[]).ok();

    // Drop the last part: parts.len() is self-consistent, the declared count is not.
    let original = pds
        .state()
        .get(PUBLISHER_DID, RELEASE, RKEY)
        .cloned()
        .unwrap();
    let set_release = |v: Value| {
        let cid = cid_of(&v);
        let mut st = pds.state();
        *st.get_mut(PUBLISHER_DID, RELEASE, RKEY).unwrap() = v;
        st.get_mut(PUBLISHER_DID, GATE, RKEY).unwrap()["release"]["cid"] = json!(cid);
    };
    let mut truncated = original.clone();
    truncated["parts"].as_array_mut().unwrap().pop();
    set_release(truncated.clone());
    let a = audit(&pds, &[]);
    assert_eq!(a.code, 2);
    let codes = a.issue_codes();
    assert!(codes.contains(&"COUNT_MISMATCH".to_string()), "{codes:?}");
    assert_eq!(a.json()["declaredPartCount"], 3);
    assert_eq!(a.json()["partCount"], 2);

    // No chunkSize either: the seal's partCount is not bound to this (new) CID,
    // so re-seal for it and check the seal is used.
    truncated.as_object_mut().unwrap().remove("chunkSize");
    truncated["imageSize"] = json!(200);
    set_release(truncated.clone());
    {
        let cid = cid_of(&truncated);
        let mut st = pds.state();
        let (rkey, _) = st.list(PUBLISHER_DID, SEAL)[0];
        let rkey = rkey.clone();
        st.get_mut(PUBLISHER_DID, SEAL, &rkey).unwrap()["release"]["cid"] = json!(cid);
    }
    let a = audit(&pds, &[]);
    assert_eq!(a.code, 2);
    assert!(a.issue_codes().contains(&"COUNT_MISMATCH".to_string()));

    // Overflowing lengths are findings, not a crash (exit 2, not 101).
    let mut hostile = original.clone();
    hostile["parts"][1]["byteLength"] = json!(u64::MAX);
    hostile["parts"][2]["byteOffset"] = json!(u64::MAX);
    set_release(hostile);
    let a = audit(&pds, &["--free-space", "1000"]);
    assert_eq!(a.code, 2, "{}", a.stderr);
    assert!(a.issue_codes().contains(&"LAYOUT_INVALID".to_string()));

    let mut hostile = original.clone();
    hostile["imageSize"] = json!(-1);
    hostile["parts"][0]["seq"] = json!(1u64 << 40);
    set_release(hostile);
    let a = audit(&pds, &[]);
    assert_eq!(a.code, 2, "{}", a.stderr);
    assert!(a.issue_codes().contains(&"TYPE_MISMATCH".to_string()));
}

#[test]
fn probe_blobs_checks_parts_and_the_whole_image() {
    let pds = MockPds::start();
    publish(&pds, "1.0.0", &[]).ok();
    let original = pds
        .state()
        .get(PUBLISHER_DID, RELEASE, RKEY)
        .cloned()
        .unwrap();

    // Corrupt one stored blob.
    let blob_cid = original["parts"][1]["blob"]["ref"]["$link"]
        .as_str()
        .unwrap()
        .to_string();
    let good = pds.state().blobs.get(&blob_cid).cloned().unwrap();
    pds.state().blobs.get_mut(&blob_cid).unwrap()[5] ^= 0xff;
    audit(&pds, &[]).ok(); // metadata alone cannot see it
    let a = audit(&pds, &["--probe-blobs"]);
    assert_eq!(a.code, 2);
    assert!(a.issue_codes().contains(&"DIGEST_INVALID".to_string()));
    pds.state().blobs.insert(blob_cid, good);
    audit(&pds, &["--probe-blobs"]).ok();

    // Every part is self-consistent but the release names another image digest.
    let mut v = original.clone();
    v["imageSha256"] = json!("ab".repeat(32));
    let cid = cid_of(&v);
    {
        let mut st = pds.state();
        *st.get_mut(PUBLISHER_DID, RELEASE, RKEY).unwrap() = v;
        st.get_mut(PUBLISHER_DID, GATE, RKEY).unwrap()["release"]["cid"] = json!(cid);
    }
    audit(&pds, &[]).ok();
    let a = audit(&pds, &["--probe-blobs"]);
    assert_eq!(a.code, 2);
    let j = a.json();
    assert_eq!(a.issue_codes(), ["DIGEST_INVALID"]);
    assert!(j["issues"][0]["message"]
        .as_str()
        .unwrap()
        .contains("assembled image"));
}

#[test]
fn optional_record_failures_are_surfaced_not_swallowed() {
    let pds = MockPds::start();
    pds.fail("com.atproto.repo.createRecord", SEAL);
    pds.fail("com.atproto.repo.createRecord", DECLARATION);
    let r = publish(&pds, "1.0.0", &[]).ok();
    let j = r.json();
    assert_eq!(j["gate"], "ready");
    let warnings = j["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 2, "{warnings:?}");
    assert!(r.stderr.contains("WARNING: release seal was not written"));
    assert!(r
        .stderr
        .contains("WARNING: actor declaration was not updated"));
}

#[test]
fn gate_write_failure_fails_the_publish_with_a_recovery_hint() {
    let pds = MockPds::start();
    pds.fail("com.atproto.repo.createRecord", GATE);
    let r = publish(&pds, "1.0.0", &[]).fails_with(1, "pipeline-skip --rkey cam-1.0.0-stable");
    assert!(r.stdout.is_empty());
    assert_eq!(channel_version(&pds), None);
}

#[test]
fn rejects_bad_input_before_touching_the_pds() {
    let pds = MockPds::start();
    let file = temp_file("ok.bin", &payload(10));
    let file = file.to_str().unwrap();
    let empty = temp_file("empty.bin", b"");
    let empty = empty.to_str().unwrap();
    let base = |product: &'static str, version: &'static str, file: &str| {
        vec![
            "publish".to_string(),
            "--product".into(),
            product.into(),
            "--version".into(),
            version.into(),
            "--file".into(),
            file.into(),
            "--yes".into(),
        ]
    };
    let run = |args: Vec<String>, needle: &str| {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        pds.publisher(&refs).fails_with(1, needle);
    };

    run(base("", "1.0.0", file), "product");
    run(base("my app", "1.0.0", file), "product");
    run(base("cam", "1.0", file), "semver");
    run(base("cam", "latest", file), "semver");
    let mut a = base("cam", "1.0.0", file);
    a.extend(["--kind".to_string(), "Firmware!".into()]);
    run(a, "kind");
    let mut a = base("cam", "1.0.0", file);
    a.extend(["--runtime".to_string(), "vm".into()]);
    run(a, "runtime");
    let mut a = base("cam", "1.0.0", file);
    a.extend(["--channel".to_string(), "a|b".into()]);
    run(a, "channel");
    let mut a = base("cam", "1.0.0", file);
    a.extend(["--stages".to_string(), "build".into()]);
    run(a, "--require-pipeline");
    let mut a = base("cam", "1.0.0", file);
    a.extend(["--oem-key".to_string(), "/nonexistent/oem.pem".into()]);
    run(a, "OEM key");
    assert!(pds.state().log.is_empty(), "no request before validation");

    run(base("cam", "1.0.0", empty), "empty");
    run(base("cam", "1.0.0", "/nonexistent/artifact.bin"), "open");

    // Without --yes and without a terminal, publish refuses instead of guessing.
    let mut a = base("cam", "1.0.0", file);
    a.pop();
    run(a, "--yes");

    pds.publisher(&[
        "pipeline-ack",
        "--rkey",
        RKEY,
        "--stage",
        "build",
        "--result",
        "ok",
    ])
    .fails_with(1, "passed|failed|skipped");
    assert_eq!(pds.state().writes(), 0);
}

#[test]
fn dry_run_writes_nothing() {
    let pds = MockPds::start();
    let file = temp_file("dry.bin", &payload(250));
    let j = pds
        .publisher(&[
            "publish",
            "--product",
            "cam",
            "--version",
            "1.0.0",
            "--file",
            file.to_str().unwrap(),
            "--dry-run",
            "--json",
        ])
        .ok()
        .json();
    assert_eq!(j["dryRun"], true);
    assert_eq!(j["cid"], "dry-run");
    assert_eq!(pds.state().writes(), 0);
}

#[test]
fn credential_handling() {
    let pds = MockPds::start();
    let file = temp_file("cred.bin", &payload(10));
    let file = file.to_str().unwrap();
    let args = |version: &'static str| {
        vec![
            "publish",
            "--product",
            "cam",
            "--version",
            version,
            "--file",
            file,
            "--yes",
            "--json",
            "--identifier",
            PUBLISHER_HANDLE,
        ]
    };

    // No password anywhere and no terminal: a clear error, no prompt hang.
    let mut cmd = pds.command();
    run(cmd.args(args("1.0.0")), None).fails_with(1, "OFW_PASSWORD");

    // --password-stdin.
    let mut cmd = pds.command();
    let mut a = args("1.0.0");
    a.push("--password-stdin");
    let r = run(cmd.args(&a), Some(&format!("{PUBLISHER_PW}\n"))).ok();
    assert!(!r.stderr.contains("WARNING"), "{}", r.stderr);

    // --password still works but warns.
    let mut cmd = pds.command();
    let mut a = args("1.0.1");
    a.extend(["--password", PUBLISHER_PW]);
    let r = run(cmd.args(&a), None).ok();
    assert!(r.stderr.contains("WARNING: --password"), "{}", r.stderr);

    // Wrong password: createSession error, exit 1.
    let mut cmd = pds.command();
    cmd.env("OFW_PASSWORD", "wrong");
    run(cmd.args(args("1.0.2")), None).fails_with(1, "createSession");

    // --password and --password-stdin together is a usage error.
    let mut cmd = pds.command();
    let mut a = args("1.0.3");
    a.extend(["--password", "x", "--password-stdin"]);
    assert_eq!(run(cmd.args(&a), None).code, 2);
}

#[test]
fn plain_http_to_a_remote_host_is_refused_for_logins() {
    let file = temp_file("http.bin", &payload(10));
    let args = [
        "publish",
        "--pds",
        "http://pds.example.invalid:2583",
        "--product",
        "cam",
        "--version",
        "1.0.0",
        "--file",
        file.to_str().unwrap(),
        "--yes",
    ];
    let mut cmd = bare_command();
    cmd.env("OFW_IDENTIFIER", PUBLISHER_HANDLE)
        .env("OFW_PASSWORD", PUBLISHER_PW);
    run(cmd.args(args), None).fails_with(1, "refusing to send credentials");

    // With the explicit flag the transport check passes (and the bogus host
    // then fails to connect, loudly warned about).
    let mut cmd = bare_command();
    cmd.env("OFW_IDENTIFIER", PUBLISHER_HANDLE)
        .env("OFW_PASSWORD", PUBLISHER_PW)
        .env("OFW_ALLOW_INSECURE_HTTP", "1");
    let r = run(cmd.args(args), None);
    assert_eq!(r.code, 1);
    assert!(r.stderr.contains("WARNING: talking to"), "{}", r.stderr);
    assert!(
        r.stderr.contains("createSession request failed"),
        "{}",
        r.stderr
    );

    let mut cmd = bare_command();
    run(
        cmd.args([
            "audit",
            "--pds",
            "ftp://x",
            "--repo",
            "did:plc:a",
            "--rkey",
            "r",
        ]),
        None,
    )
    .fails_with(1, "scheme");
}
