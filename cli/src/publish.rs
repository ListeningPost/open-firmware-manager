//! Publish a file as a signed release chain to a production AT Protocol PDS.

use crate::atproto::{
    AtpClient, BlobRef, StrongRef, COLLECTION_CHUNK, COLLECTION_RELEASE, COLLECTION_SEAL,
};
use crate::audit::{audit_release_chain, AuditOptions, ChunkMeta, ReleaseMeta};
use crate::chunk::{chunk_bytes, release_rkey, ChunkedArtifact};
use anyhow::{Context, Result};
use chrono::Utc;
use indicatif::{ProgressBar, ProgressStyle};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct PublishArgs {
    pub product: String,
    pub version: String,
    pub channel: String,
    pub kind: String,
    pub file: std::path::PathBuf,
    pub chunk_size: usize,
    pub mime_type: String,
    pub changelog: Option<String>,
    pub platform: Option<String>,
    pub runtime: String,
    pub dry_run: bool,
    /// Skip CI/pipeline gate (default true).
    pub skip_pipeline: bool,
    /// Required stages when not skipping (e.g. build,test).
    pub required_pipeline_stages: Vec<String>,
}

#[derive(Debug)]
pub struct PublishResult {
    pub release: StrongRef,
    pub chunk_count: u32,
    pub image_sha256: String,
    pub image_size: u64,
    pub rkey: String,
    pub author_did: String,
    pub status: String,
}

pub fn plan_from_file(path: &Path, chunk_size: usize) -> Result<ChunkedArtifact> {
    let data = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    chunk_bytes(&data, chunk_size)
}

pub fn print_plan(product: &str, version: &str, channel: &str, kind: &str, plan: &ChunkedArtifact) {
    println!("Release plan");
    println!("  product:      {product}");
    println!("  version:      {version}");
    println!("  channel:      {channel}");
    println!("  kind:         {kind}");
    println!("  imageSize:    {} bytes", plan.image_size);
    println!("  imageSha256:  {}", plan.image_sha256);
    println!("  chunkCount:   {}", plan.chunks.len());
    for c in &plan.chunks {
        println!(
            "    chunk[{}]: offset={} len={} sha256={}…",
            c.seq,
            c.byte_offset,
            c.byte_length,
            &c.sha256[..12.min(c.sha256.len())]
        );
    }
}

pub fn publish(client: &AtpClient, args: &PublishArgs) -> Result<PublishResult> {
    let plan = plan_from_file(&args.file, args.chunk_size)?;
    print_plan(
        &args.product,
        &args.version,
        &args.channel,
        &args.kind,
        &plan,
    );

    let rkey = release_rkey(&args.product, &args.version, &args.channel);
    let release_uri_preview = format!(
        "at://{}/{COLLECTION_RELEASE}/{rkey}",
        client.session.did
    );

    let meta_chunks: Vec<ChunkMeta> = plan
        .chunks
        .iter()
        .map(|c| ChunkMeta {
            seq: c.seq,
            sha256: c.sha256.clone(),
            byte_offset: c.byte_offset,
            byte_length: c.byte_length,
            blob_cid: None,
            blob_size: Some(c.byte_length),
            author_did: Some(client.session.did.clone()),
            root_uri: Some(release_uri_preview.clone()),
            parent_uri: None,
            uri: None,
            cid: None,
        })
        .collect();

    let pre = ReleaseMeta {
        version: args.version.clone(),
        product: args.product.clone(),
        kind: args.kind.clone(),
        image_sha256: plan.image_sha256.clone(),
        image_size: plan.image_size,
        chunk_count: plan.chunks.len() as u32,
        channel: args.channel.clone(),
        status: "ready".into(),
        author_did: client.session.did.clone(),
        uri: Some(release_uri_preview.clone()),
        cid: None,
    };
    let report = audit_release_chain(&pre, &meta_chunks, &AuditOptions::default());
    let hard: Vec<_> = report
        .issues
        .iter()
        .filter(|i| i.code != "CHAIN_BROKEN")
        .collect();
    if !hard.is_empty() {
        for i in &hard {
            eprintln!("preflight {}: {}", i.code, i.message);
        }
        anyhow::bail!("local preflight failed");
    }

    if args.dry_run {
        println!("[dry-run] OK — no blobs or records written");
        return Ok(PublishResult {
            release: StrongRef {
                uri: release_uri_preview,
                cid: "dry-run".into(),
            },
            chunk_count: plan.chunks.len() as u32,
            image_sha256: plan.image_sha256,
            image_size: plan.image_size,
            rkey,
            author_did: client.session.did.clone(),
            status: if args.skip_pipeline {
                "ready".into()
            } else {
                "awaiting_pipeline".into()
            },
        });
    }

    let require_pipeline = !args.skip_pipeline;
    let stages = if require_pipeline && args.required_pipeline_stages.is_empty() {
        vec!["build".to_string(), "test".to_string()]
    } else {
        args.required_pipeline_stages.clone()
    };

    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut release_record = json!({
        "$type": COLLECTION_RELEASE,
        "version": args.version,
        "product": args.product,
        "kind": args.kind,
        "createdAt": now,
        "imageSha256": plan.image_sha256,
        "imageSize": plan.image_size,
        "chunkCount": plan.chunks.len(),
        "chunkSize": args.chunk_size,
        "mimeType": args.mime_type,
        "channel": args.channel,
        "status": "publishing",
        "runtime": args.runtime,
        "requirePipelineAcks": require_pipeline,
        "pipelinePolicy": if require_pipeline { "strict" } else { "skipped" },
    });
    if require_pipeline {
        release_record["requiredPipelineStages"] = json!(stages);
    }
    if let Some(c) = &args.changelog {
        release_record["changelog"] = json!(c);
    }
    if let Some(p) = &args.platform {
        release_record["platform"] = json!(p);
    }

    println!("Creating release record (status=publishing)…");
    let release_ref = client
        .put_record(COLLECTION_RELEASE, &rkey, release_record.clone())
        .or_else(|_| client.create_record(COLLECTION_RELEASE, release_record.clone(), Some(&rkey)))
        .context("create/put release record")?;

    println!("  uri: {}", release_ref.uri);
    println!("  cid: {}", release_ref.cid);

    let pb = ProgressBar::new(plan.chunks.len() as u64);
    pb.set_style(
        ProgressStyle::with_template(
            "{spinner:.green} [{bar:40.cyan/blue}] {pos}/{len} chunks {msg}",
        )
        .unwrap()
        .progress_chars("=>-"),
    );

    let mut prev: StrongRef = release_ref.clone();
    let root = release_ref.clone();
    let mut uploaded: Vec<(u32, BlobRef, StrongRef)> = Vec::new();

    for c in &plan.chunks {
        pb.set_message(format!("seq {}", c.seq));
        let blob = client
            .upload_blob(&c.data, &args.mime_type)
            .with_context(|| format!("uploadBlob seq {}", c.seq))?;

        let chunk_record = json!({
            "$type": COLLECTION_CHUNK,
            "reply": {
                "root": { "uri": root.uri, "cid": root.cid },
                "parent": { "uri": prev.uri, "cid": prev.cid },
            },
            "seq": c.seq,
            "blob": blob,
            "sha256": c.sha256,
            "byteOffset": c.byte_offset,
            "byteLength": c.byte_length,
            "createdAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        });

        let chunk_ref = client
            .create_record(COLLECTION_CHUNK, chunk_record, None)
            .with_context(|| format!("create chunk seq {}", c.seq))?;

        prev = chunk_ref.clone();
        uploaded.push((c.seq, blob, chunk_ref));
        pb.inc(1);
    }
    pb.finish_with_message("chunks uploaded");

    let next_status = if require_pipeline {
        "awaiting_pipeline"
    } else {
        "ready"
    };
    release_record["status"] = json!(next_status);
    let final_ref = client
        .put_record(COLLECTION_RELEASE, &rkey, release_record)
        .with_context(|| format!("set status={next_status}"))?;

    if !require_pipeline {
        let seal = json!({
            "$type": COLLECTION_SEAL,
            "release": { "uri": final_ref.uri, "cid": final_ref.cid },
            "chunkCount": plan.chunks.len(),
            "imageSha256": plan.image_sha256,
            "createdAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        });
        let _ = client.create_record(COLLECTION_SEAL, seal, None);
    }

    println!();
    if require_pipeline {
        println!("Release uploaded — awaiting_pipeline.");
        println!("  Required stages: {}", stages.join(", "));
        println!("  Next: ofw pipeline-ack --stage build --result passed --rkey {rkey} ...");
        println!("        ofw pipeline-ack --stage test  --result passed --rkey {rkey}");
        println!("  Or skip: ofw pipeline-skip --rkey {rkey}");
    } else {
        println!("Release ready (pipeline skipped).");
        println!("  Sidekar will pick this up on the next poll of this PDS.");
    }
    println!("  author:  {}", client.session.did);
    println!("  uri:     {}", final_ref.uri);
    println!("  cid:     {}", final_ref.cid);
    println!("  status:  {next_status}");
    println!("  chunks:  {}", uploaded.len());
    println!("  sha256:  {}", plan.image_sha256);
    println!(
        "  Verify: ofw audit --pds {} --repo {} --rkey {rkey}",
        client.session.pds, client.session.did
    );

    Ok(PublishResult {
        release: final_ref,
        chunk_count: plan.chunks.len() as u32,
        image_sha256: plan.image_sha256,
        image_size: plan.image_size,
        rkey,
        author_did: client.session.did.clone(),
        status: next_status.to_string(),
    })
}

pub fn result_json(res: &PublishResult) -> Value {
    json!({
        "uri": res.release.uri,
        "cid": res.release.cid,
        "rkey": res.rkey,
        "authorDid": res.author_did,
        "chunkCount": res.chunk_count,
        "imageSha256": res.image_sha256,
        "imageSize": res.image_size,
        "status": res.status,
    })
}
