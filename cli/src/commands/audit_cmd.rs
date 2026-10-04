use crate::atproto::{parse_at_uri, AtpClient, COLLECTION_GATE, COLLECTION_RELEASE};
use crate::audit::{audit_release_chain, AuditOptions, ChunkMeta, ReleaseMeta};
use crate::chunk::{is_sha256_hex, sha256_hex};
use anyhow::{Context, Result};
use clap::Args;

#[derive(Debug, Args)]
pub struct AuditCmd {
    #[arg(long, env = "OFW_PDS")]
    pub pds: String,
    #[arg(long, env = "OFW_REPO")]
    pub repo: String,
    #[arg(long)]
    pub rkey: String,
    #[arg(long)]
    pub free_space: Option<u64>,
    #[arg(long, env = "OFW_IDENTIFIER")]
    pub identifier: Option<String>,
    #[arg(long, env = "OFW_PASSWORD")]
    pub password: Option<String>,
    #[arg(long)]
    pub json: bool,
    /// Download each blob and verify sha256 (Phase B probe)
    #[arg(long)]
    pub probe_blobs: bool,
}

pub fn run(cmd: AuditCmd) -> Result<()> {
    let client = if let (Some(id), Some(pw)) = (&cmd.identifier, &cmd.password) {
        AtpClient::login(&cmd.pds, id, pw)?
    } else {
        AtpClient::anonymous(&cmd.pds)?
    };

    let release_val = client.get_record(COLLECTION_RELEASE, &cmd.rkey, Some(&cmd.repo))?;
    let uri = release_val
        .get("uri")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cid = release_val
        .get("cid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let value = release_val
        .get("value")
        .cloned()
        .context("release missing value")?;

    let mut status = "ready".to_string();
    if let Ok(gate) = client.get_record(COLLECTION_GATE, &cmd.rkey, Some(&cmd.repo)) {
        if let Some(s) = gate.pointer("/value/state").and_then(|v| v.as_str()) {
            status = s.to_string();
        }
    }

    let parts = value
        .get("parts")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();

    let release = ReleaseMeta {
        version: value["version"].as_str().unwrap_or("").into(),
        product: value["product"].as_str().unwrap_or("").into(),
        kind: value["kind"].as_str().unwrap_or("").into(),
        image_sha256: value["imageSha256"].as_str().unwrap_or("").into(),
        image_size: value["imageSize"].as_u64().unwrap_or(0),
        chunk_count: parts.len() as u32,
        channel: value["channel"].as_str().unwrap_or("stable").into(),
        status,
        author_did: parse_at_uri(&uri)
            .map(|(did, _, _)| did)
            .unwrap_or_else(|| cmd.repo.clone()),
        uri: Some(uri.clone()),
        cid: Some(cid),
    };

    let mut chunks: Vec<ChunkMeta> = Vec::new();
    for p in parts {
        let blob_cid = p
            .pointer("/blob/ref/$link")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let blob_size = p.pointer("/blob/size").and_then(|x| x.as_u64());
        chunks.push(ChunkMeta {
            seq: p["seq"].as_u64().unwrap_or(0) as u32,
            sha256: p["sha256"].as_str().unwrap_or("").into(),
            byte_offset: p["byteOffset"].as_u64().unwrap_or(0),
            byte_length: p["byteLength"].as_u64().unwrap_or(0),
            blob_cid,
            blob_size,
            author_did: Some(cmd.repo.clone()),
        });
    }

    let mut report = audit_release_chain(
        &release,
        &chunks,
        &AuditOptions {
            free_space_bytes: cmd.free_space,
            require_ready: true,
            ..Default::default()
        },
    );

    if cmd.probe_blobs && report.ok {
        let did = release.author_did.clone();
        for c in &chunks {
            let Some(cid) = &c.blob_cid else {
                report.ok = false;
                report.issues.push(crate::audit::AuditIssue {
                    code: "BLOB_UNAVAILABLE".into(),
                    message: format!("part {} missing blob CID", c.seq),
                    seq: Some(c.seq),
                });
                continue;
            };
            match client.get_blob(&did, cid) {
                Ok(bytes) => {
                    if bytes.len() as u64 != c.byte_length {
                        report.ok = false;
                        report.issues.push(crate::audit::AuditIssue {
                            code: "BLOB_SIZE_MISMATCH".into(),
                            message: format!(
                                "part {} size {} != {}",
                                c.seq,
                                bytes.len(),
                                c.byte_length
                            ),
                            seq: Some(c.seq),
                        });
                    }
                    let got = sha256_hex(&bytes);
                    if !got.eq_ignore_ascii_case(&c.sha256) {
                        report.ok = false;
                        report.issues.push(crate::audit::AuditIssue {
                            code: "DIGEST_INVALID".into(),
                            message: format!("part {} sha256 mismatch", c.seq),
                            seq: Some(c.seq),
                        });
                    }
                }
                Err(e) => {
                    report.ok = false;
                    report.issues.push(crate::audit::AuditIssue {
                        code: "BLOB_UNAVAILABLE".into(),
                        message: format!("part {} getBlob: {e}", c.seq),
                        seq: Some(c.seq),
                    });
                }
            }
        }
    }

    if cmd.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!(
            "Phase A audit for {}",
            release.uri.as_deref().unwrap_or(&cmd.rkey)
        );
        println!(
            "  product={} version={} gate={} parts={}",
            release.product,
            release.version,
            release.status,
            chunks.len()
        );
        if !is_sha256_hex(&release.image_sha256) {
            println!("  warning: imageSha256 format odd");
        }
        if report.ok {
            println!("  OK — metadata is unbothered; safe to download (Phase B).");
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
