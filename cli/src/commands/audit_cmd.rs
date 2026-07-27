use crate::atproto::{AtpClient, COLLECTION_CHUNK, COLLECTION_RELEASE};
use crate::audit::{audit_release_chain, AuditOptions, ChunkMeta, ReleaseMeta};
use crate::chunk::is_sha256_hex;
use anyhow::{Context, Result};
use clap::Args;
use serde_json::Value;

#[derive(Debug, Args)]
pub struct AuditCmd {
    /// PDS base URL
    #[arg(long, env = "OFW_PDS")]
    pub pds: String,

    /// Repo DID (author)
    #[arg(long, env = "OFW_REPO")]
    pub repo: String,

    /// Release rkey (product-version-channel)
    #[arg(long)]
    pub rkey: String,

    /// Optional free space check (bytes)
    #[arg(long)]
    pub free_space: Option<u64>,

    /// App password only needed if PDS requires auth for getRecord (usually public)
    #[arg(long, env = "OFW_IDENTIFIER")]
    pub identifier: Option<String>,

    #[arg(long, env = "OFW_PASSWORD")]
    pub password: Option<String>,

    #[arg(long)]
    pub json: bool,
}

pub fn run(cmd: AuditCmd) -> Result<()> {
    // Prefer authenticated client if credentials present; else anonymous get via login optional
    let (release_val, chunks_val, author_did) =
        if let (Some(id), Some(pw)) = (&cmd.identifier, &cmd.password) {
            let client = AtpClient::login(&cmd.pds, id, pw)?;
            let rel = client.get_record(COLLECTION_RELEASE, &cmd.rkey, Some(&cmd.repo))?;
            let listed = client.list_records(COLLECTION_CHUNK, &cmd.repo, 100)?;
            (rel, listed, client.session.did)
        } else {
            // anonymous HTTP getRecord / listRecords
            let http = reqwest::blocking::Client::new();
            let pds = cmd.pds.trim_end_matches('/');
            let rel: Value = http
                .get(format!("{pds}/xrpc/com.atproto.repo.getRecord"))
                .query(&[
                    ("repo", cmd.repo.as_str()),
                    ("collection", COLLECTION_RELEASE),
                    ("rkey", cmd.rkey.as_str()),
                ])
                .send()?
                .error_for_status()?
                .json()?;
            let listed: Value = http
                .get(format!("{pds}/xrpc/com.atproto.repo.listRecords"))
                .query(&[
                    ("repo", cmd.repo.as_str()),
                    ("collection", COLLECTION_CHUNK),
                    ("limit", "100"),
                ])
                .send()?
                .error_for_status()?
                .json()?;
            (rel, listed, cmd.repo.clone())
        };

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

    let release = ReleaseMeta {
        version: value["version"].as_str().unwrap_or("").into(),
        product: value["product"].as_str().unwrap_or("").into(),
        kind: value["kind"].as_str().unwrap_or("").into(),
        image_sha256: value["imageSha256"].as_str().unwrap_or("").into(),
        image_size: value["imageSize"].as_u64().unwrap_or(0),
        chunk_count: value["chunkCount"].as_u64().unwrap_or(0) as u32,
        channel: value["channel"].as_str().unwrap_or("stable").into(),
        status: value["status"].as_str().unwrap_or("").into(),
        author_did: author_did.clone(),
        uri: Some(uri.clone()),
        cid: Some(cid),
    };

    let records = chunks_val
        .get("records")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();

    let mut chunks: Vec<ChunkMeta> = Vec::new();
    for rec in records {
        let v = rec.get("value").cloned().unwrap_or(Value::Null);
        // only chunks for this release root
        let root_uri = v
            .pointer("/reply/root/uri")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        if !uri.is_empty() && root_uri != uri {
            continue;
        }
        let blob_cid = v
            .pointer("/blob/ref/$link")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let blob_size = v.pointer("/blob/size").and_then(|x| x.as_u64());
        chunks.push(ChunkMeta {
            seq: v["seq"].as_u64().unwrap_or(0) as u32,
            sha256: v["sha256"].as_str().unwrap_or("").into(),
            byte_offset: v["byteOffset"].as_u64().unwrap_or(0),
            byte_length: v["byteLength"].as_u64().unwrap_or(0),
            blob_cid,
            blob_size,
            author_did: Some(author_did.clone()),
            root_uri: Some(root_uri.into()),
            parent_uri: v
                .pointer("/reply/parent/uri")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            uri: rec.get("uri").and_then(|x| x.as_str()).map(|s| s.to_string()),
            cid: rec.get("cid").and_then(|x| x.as_str()).map(|s| s.to_string()),
        });
    }

    let report = audit_release_chain(
        &release,
        &chunks,
        &AuditOptions {
            free_space_bytes: cmd.free_space,
            require_ready: true,
            ..Default::default()
        },
    );

    if cmd.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("Phase A audit for {}", release.uri.as_deref().unwrap_or(&cmd.rkey));
        println!(
            "  product={} version={} status={} chunks_found={}/{}",
            release.product,
            release.version,
            release.status,
            chunks.len(),
            release.chunk_count
        );
        if !is_sha256_hex(&release.image_sha256) {
            println!("  warning: imageSha256 format odd");
        }
        if report.ok {
            println!("  OK — chain metadata is unbothered; safe to download (Phase B).");
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
