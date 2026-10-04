//! Publish a file as an immutable release + channel pointer.

use crate::atproto::{
    AtpClient, StrongRef, COLLECTION_CHANNEL, COLLECTION_DECLARATION, COLLECTION_GATE,
    COLLECTION_RELEASE, COLLECTION_SEAL,
};
use crate::audit::{audit_release_chain, AuditOptions, ChunkMeta, ReleaseMeta};
use crate::chunk::{chunk_bytes, release_rkey, channel_rkey, ChunkedArtifact};
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
    /// When true, human logs are suppressed (`ofw publish --json`).
    pub quiet: bool,
    pub skip_pipeline: bool,
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
    eprintln!("Release plan");
    eprintln!("  product:      {product}");
    eprintln!("  version:      {version}");
    eprintln!("  channel:      {channel}");
    eprintln!("  kind:         {kind}");
    eprintln!("  imageSize:    {} bytes", plan.image_size);
    eprintln!("  imageSha256:  {}", plan.image_sha256);
    eprintln!("  partCount:    {}", plan.chunks.len());
}

fn hlog(quiet: bool, msg: impl std::fmt::Display) {
    if !quiet {
        eprintln!("{msg}");
    }
}

pub fn publish(client: &mut AtpClient, args: &PublishArgs) -> Result<PublishResult> {
    let plan = plan_from_file(&args.file, args.chunk_size)?;
    if !args.quiet {
        print_plan(
            &args.product,
            &args.version,
            &args.channel,
            &args.kind,
            &plan,
        );
    }

    let rkey = release_rkey(&args.product, &args.version, &args.channel);
    let ch_rkey = channel_rkey(&args.product, &args.channel);
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
    if !report.ok {
        for i in &report.issues {
            eprintln!("preflight {}: {}", i.code, i.message);
        }
        anyhow::bail!("local preflight failed");
    }

    let next_status = if args.skip_pipeline {
        "ready"
    } else {
        "awaiting-pipeline"
    };

    if args.dry_run {
        hlog(args.quiet, "[dry-run] OK — no blobs or records written");
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
            status: next_status.into(),
        });
    }

    let require_pipeline = !args.skip_pipeline;
    let stages = if require_pipeline && args.required_pipeline_stages.is_empty() {
        vec!["build".to_string(), "test".to_string()]
    } else {
        args.required_pipeline_stages.clone()
    };

    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let pb = ProgressBar::new(plan.chunks.len() as u64);
    if args.quiet {
        pb.set_draw_target(indicatif::ProgressDrawTarget::hidden());
    }
    pb.set_style(
        ProgressStyle::with_template(
            "{spinner:.green} [{bar:40.cyan/blue}] {pos}/{len} parts {msg}",
        )
        .unwrap()
        .progress_chars("=>-"),
    );

    let mut parts = Vec::new();
    for c in &plan.chunks {
        pb.set_message(format!("seq {}", c.seq));
        let blob = client
            .upload_blob(&c.data, &args.mime_type)
            .with_context(|| format!("uploadBlob seq {}", c.seq))?;
        parts.push(json!({
            "seq": c.seq,
            "blob": blob,
            "sha256": c.sha256,
            "byteOffset": c.byte_offset,
            "byteLength": c.byte_length,
        }));
        pb.inc(1);
    }
    pb.finish_with_message("blobs uploaded");

    let mut release_record = json!({
        "$type": COLLECTION_RELEASE,
        "version": args.version,
        "product": args.product,
        "kind": args.kind,
        "createdAt": now,
        "imageSha256": plan.image_sha256,
        "imageSize": plan.image_size,
        "chunkSize": args.chunk_size,
        "mimeType": args.mime_type,
        "channel": args.channel,
        "parts": parts,
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

    hlog(args.quiet, format!("Creating immutable release {rkey}…"));
    let release_ref = upsert(client, COLLECTION_RELEASE, &rkey, release_record)?;
    hlog(args.quiet, format!("  uri: {}", release_ref.uri));
    hlog(args.quiet, format!("  cid: {}", release_ref.cid));

    upsert(
        client,
        COLLECTION_GATE,
        &rkey,
        json!({
            "$type": COLLECTION_GATE,
            "release": { "uri": release_ref.uri, "cid": release_ref.cid },
            "state": next_status,
            "updatedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }),
    )?;

    if args.skip_pipeline {
        upsert(
            client,
            COLLECTION_CHANNEL,
            &ch_rkey,
            json!({
                "$type": COLLECTION_CHANNEL,
                "product": args.product,
                "channel": args.channel,
                "release": { "uri": release_ref.uri, "cid": release_ref.cid },
                "version": args.version,
                "updatedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            }),
        )?;
        let seal = json!({
            "$type": COLLECTION_SEAL,
            "release": { "uri": release_ref.uri, "cid": release_ref.cid },
            "partCount": plan.chunks.len(),
            "imageSha256": plan.image_sha256,
            "createdAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        });
        let _ = client.create_record(COLLECTION_SEAL, seal, None);
    }

    let _ = ensure_declaration(client, &args.product);

    if require_pipeline {
        hlog(args.quiet, "Release uploaded — awaiting-pipeline.");
        hlog(args.quiet, format!("  Required stages: {}", stages.join(", ")));
        hlog(
            args.quiet,
            format!("  Next: ofw pipeline-ack --stage build --result passed --rkey {rkey}"),
        );
    } else {
        hlog(
            args.quiet,
            format!("Release ready (pipeline skipped). Channel {ch_rkey} updated."),
        );
    }
    hlog(args.quiet, format!("  author:  {}", client.session.did));
    hlog(args.quiet, format!("  uri:     {}", release_ref.uri));
    hlog(args.quiet, format!("  cid:     {}", release_ref.cid));
    hlog(args.quiet, format!("  gate:    {next_status}"));
    hlog(args.quiet, format!("  sha256:  {}", plan.image_sha256));

    Ok(PublishResult {
        release: release_ref,
        chunk_count: plan.chunks.len() as u32,
        image_sha256: plan.image_sha256,
        image_size: plan.image_size,
        rkey,
        author_did: client.session.did.clone(),
        status: next_status.to_string(),
    })
}

pub fn upsert(
    client: &mut AtpClient,
    collection: &str,
    rkey: &str,
    record: Value,
) -> Result<StrongRef> {
    match client.get_record(collection, rkey, Some(&client.session.did.clone())) {
        Ok(existing) => {
            let cid = existing.get("cid").and_then(|c| c.as_str()).map(|s| s.to_string());
            client.put_record(collection, rkey, record, cid.as_deref())
        }
        Err(_) => client.create_record(collection, record, Some(rkey)),
    }
}

fn ensure_declaration(client: &mut AtpClient, product: &str) -> Result<()> {
    match client.get_record(COLLECTION_DECLARATION, "self", Some(&client.session.did.clone())) {
        Ok(existing) => {
            let cid = existing
                .get("cid")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string());
            let mut value = existing
                .get("value")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let mut products: Vec<String> = value
                .get("products")
                .and_then(|p| p.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            if !products.iter().any(|p| p == product) {
                products.push(product.to_string());
            }
            value["$type"] = json!(COLLECTION_DECLARATION);
            value["products"] = json!(products);
            client.put_record(COLLECTION_DECLARATION, "self", value, cid.as_deref())?;
        }
        Err(_) => {
            client.create_record(
                COLLECTION_DECLARATION,
                json!({
                    "$type": COLLECTION_DECLARATION,
                    "products": [product],
                    "createdAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                }),
                Some("self"),
            )?;
        }
    }
    Ok(())
}

pub fn result_json(res: &PublishResult) -> Value {
    json!({
        "uri": res.release.uri,
        "cid": res.release.cid,
        "rkey": res.rkey,
        "authorDid": res.author_did,
        "partCount": res.chunk_count,
        "imageSha256": res.image_sha256,
        "imageSize": res.image_size,
        "gate": res.status,
    })
}
