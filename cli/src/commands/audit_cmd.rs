use crate::atproto::{
    parse_at_uri, record_parts, AtpClient, COLLECTION_GATE, COLLECTION_RELEASE, COLLECTION_SEAL,
};
use crate::audit::{
    audit_release_chain, parse_release_record, verify_parts, AuditIssue, AuditOptions, ReleaseMeta,
};
use crate::chunk::MAX_BLOB_BYTES;
use crate::commands::common::{login_or_anonymous, LoginArgs, PdsArgs};
use crate::pipeline::GateView;
use crate::sign::{check_oem_signature, parse_trusted_keys, OemCheck, SignedFields};
use anyhow::{Context, Result};
use clap::Args;
use serde_json::{json, Value};

#[derive(Debug, Args)]
pub struct AuditCmd {
    #[command(flatten)]
    pub pds: PdsArgs,
    /// Publisher repo: a DID, or a handle (resolved to a DID on this PDS)
    #[arg(long, env = "OFW_REPO")]
    pub repo: String,
    #[arg(long)]
    pub rkey: String,
    /// Free bytes on the target; fail if the image does not fit
    #[arg(long)]
    pub free_space: Option<u64>,
    #[command(flatten)]
    pub login: LoginArgs,
    #[arg(long)]
    pub json: bool,
    /// Download every blob; verify each part and the whole-image SHA-256
    #[arg(long)]
    pub probe_blobs: bool,
    /// Pinned OEM public key (base64url, 32 bytes). Repeatable / comma-separated.
    /// When given, the release must carry a valid signature from one of them.
    #[arg(
        long = "trusted-oem-key",
        env = "OFW_TRUSTED_OEM_KEYS",
        value_delimiter = ','
    )]
    pub trusted_oem_keys: Vec<String>,
}

/// Gate state as seen by the audit; `missing` is never `ready`.
fn gate_status(
    client: &mut AtpClient,
    repo_did: &str,
    rkey: &str,
    release_cid: &str,
    issues: &mut Vec<AuditIssue>,
) -> Result<String> {
    // A gate we cannot read is an error, not "ready".
    let gate = client
        .get_record_opt(COLLECTION_GATE, rkey, repo_did)
        .with_context(|| format!("fetch gate {rkey} (cannot tell whether the release is ready)"))?;
    let Some(gate) = gate else {
        return Ok("missing".into());
    };
    let view = GateView::from_record_value(gate.get("value").unwrap_or(&Value::Null));
    if view.release_cid.as_deref() != Some(release_cid) {
        issues.push(AuditIssue::new(
            "GATE_MISMATCH",
            format!(
                "gate refers to release cid {}, but the release record is {release_cid}",
                view.release_cid.as_deref().unwrap_or("(none)")
            ),
            None,
        ));
    }
    Ok(if view.state.is_empty() {
        "missing".into()
    } else {
        view.state
    })
}

/// Part count the publisher sealed for this exact release version, if any.
fn sealed_part_count(
    client: &mut AtpClient,
    repo_did: &str,
    uri: &str,
    cid: &str,
) -> Result<Option<u64>> {
    let seals = client
        .list_records(COLLECTION_SEAL, repo_did)
        .context("list release seals")?;
    Ok(seals
        .iter()
        .filter(|s| {
            s.pointer("/value/release/uri").and_then(Value::as_str) == Some(uri)
                && s.pointer("/value/release/cid").and_then(Value::as_str) == Some(cid)
        })
        .filter_map(|s| s.pointer("/value/partCount").and_then(Value::as_u64))
        .next_back())
}

pub fn run(cmd: AuditCmd) -> Result<()> {
    let trusted = parse_trusted_keys(&cmd.trusted_oem_keys)?;
    let mut client = login_or_anonymous(&cmd.pds, &cmd.login)?;

    // Records are addressed by DID; a handle must be resolved first or every
    // part would look like it came from a different author.
    let repo_did = if cmd.repo.starts_with("did:") {
        cmd.repo.clone()
    } else {
        client
            .resolve_handle(&cmd.repo)
            .with_context(|| format!("resolve handle {}", cmd.repo))?
    };

    let rec = client
        .get_record(COLLECTION_RELEASE, &cmd.rkey, &repo_did)
        .with_context(|| format!("fetch release {} from {repo_did}", cmd.rkey))?;
    let (uri, cid, value) = record_parts(&rec, "release")?;

    let mut extra: Vec<AuditIssue> = Vec::new();
    match parse_at_uri(&uri) {
        Some((did, collection, rkey))
            if did == repo_did && collection == COLLECTION_RELEASE && rkey == cmd.rkey => {}
        _ => extra.push(AuditIssue::new(
            "AUTHOR_MISMATCH",
            format!(
                "PDS answered with {uri}, not the requested release {} in {repo_did}",
                cmd.rkey
            ),
            None,
        )),
    }

    let status = gate_status(&mut client, &repo_did, &cmd.rkey, &cid, &mut extra)?;
    let parsed = parse_release_record(&value, &repo_did);
    extra.extend(parsed.issues.iter().cloned());

    // The declared count must come from somewhere other than parts.len(),
    // or a truncated parts array could never be noticed.
    let declared: u64 = match parsed.count_from_chunk_size() {
        Some(n) => n,
        None => sealed_part_count(&mut client, &repo_did, &uri, &cid)?
            .unwrap_or(parsed.chunks.len() as u64),
    };

    let release = ReleaseMeta {
        version: parsed.version.clone(),
        product: parsed.product.clone(),
        kind: parsed.kind.clone(),
        image_sha256: parsed.image_sha256.clone(),
        image_size: parsed.image_size,
        chunk_count: u32::try_from(declared).unwrap_or(u32::MAX),
        channel: parsed.channel.clone(),
        status,
        author_did: repo_did.clone(),
        uri: Some(uri.clone()),
        cid: Some(cid.clone()),
    };

    let mut report = audit_release_chain(
        &release,
        &parsed.chunks,
        &AuditOptions {
            free_space_bytes: cmd.free_space,
            require_ready: true,
            ..Default::default()
        },
    );
    report.issues.splice(0..0, extra);

    let oem = check_oem_signature(
        parsed.oem_signature.as_ref(),
        &SignedFields {
            product: &parsed.product,
            version: &parsed.version,
            channel: &parsed.channel,
            image_sha256: &parsed.image_sha256,
            image_size: parsed.image_size,
        },
        &trusted,
    );
    let pinned = !trusted.is_empty();
    let oem_json = match &oem {
        OemCheck::Missing => {
            if pinned {
                report.issues.push(AuditIssue::new(
                    "OEM_SIG_MISSING",
                    "release has no oemSignature but --trusted-oem-key requires one",
                    None,
                ));
            }
            json!({ "status": "missing" })
        }
        OemCheck::Invalid(why) => {
            // A signature that is present but wrong is never acceptable.
            report.issues.push(AuditIssue::new(
                "OEM_SIG_INVALID",
                format!("oemSignature: {why}"),
                None,
            ));
            json!({ "status": "invalid", "reason": why })
        }
        OemCheck::Valid {
            public_key,
            key_id,
            trusted,
        } => {
            if pinned && !trusted {
                report.issues.push(AuditIssue::new(
                    "OEM_SIG_INVALID",
                    format!("oem public key {public_key} is not a trusted OEM key"),
                    None,
                ));
            }
            json!({
                // "unpinned": the math checks out, but the key came from the
                // record itself, so it proves nothing without --trusted-oem-key.
                "status": if *trusted { "trusted" } else if pinned { "untrusted" } else { "unpinned" },
                "publicKey": public_key,
                "keyId": key_id,
            })
        }
    };

    let mut probed = false;
    if cmd.probe_blobs && report.issues.is_empty() {
        probed = true;
        let found = verify_parts(&release, &parsed.chunks, |c| {
            let blob_cid = c.blob_cid.as_deref().context("part has no blob CID")?;
            if c.byte_length > MAX_BLOB_BYTES as u64 {
                anyhow::bail!("declared part size {} exceeds the blob cap", c.byte_length);
            }
            client.get_blob(&repo_did, blob_cid, c.byte_length)
        });
        report.issues.extend(found);
    }
    report.ok = report.issues.is_empty();

    if cmd.json {
        let mut out = serde_json::to_value(&report)?;
        out["uri"] = json!(uri);
        out["cid"] = json!(cid);
        out["authorDid"] = json!(repo_did);
        out["gate"] = json!(release.status);
        out["partCount"] = json!(parsed.chunks.len());
        out["declaredPartCount"] = json!(declared);
        out["blobsProbed"] = json!(probed);
        out["oemSignature"] = oem_json;
        println!("{}", serde_json::to_string_pretty(&out)?);
    } else {
        println!("Audit for {uri}");
        println!(
            "  product={} version={} gate={} parts={}",
            release.product,
            release.version,
            release.status,
            parsed.chunks.len()
        );
        match oem_json["status"].as_str().unwrap_or("") {
            "trusted" => println!(
                "  OEM signature: valid, trusted key {}",
                oem_json["publicKey"].as_str().unwrap_or("")
            ),
            "unpinned" => println!(
                "  OEM signature: self-consistent with key {} — NOT verified against a \
                 pinned key (pass --trusted-oem-key)",
                oem_json["publicKey"].as_str().unwrap_or("")
            ),
            "missing" => println!("  OEM signature: none"),
            other => println!("  OEM signature: {other}"),
        }
        if cmd.probe_blobs && !probed {
            println!("  blobs NOT probed: metadata already failed");
        }
        if report.ok {
            if probed {
                println!(
                    "  OK — metadata and every blob verified (per-part and whole-image SHA-256)."
                );
            } else {
                println!("  OK — metadata is consistent; safe to download (Phase B).");
            }
        } else {
            println!("  FAILED — do not download/apply:");
            for i in &report.issues {
                println!("    [{}] {}", i.code, i.message);
            }
        }
    }

    if report.ok {
        Ok(())
    } else {
        std::process::exit(2);
    }
}
