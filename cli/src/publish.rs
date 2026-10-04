//! Publish a file as an immutable release + mutable gate / channel sidecars.

use crate::atproto::{
    record_parts, AtpClient, StrongRef, COLLECTION_CHANNEL, COLLECTION_DECLARATION,
    COLLECTION_GATE, COLLECTION_RELEASE, COLLECTION_SEAL,
};
use crate::audit::{audit_release_chain, AuditOptions, ChunkMeta, ReleaseMeta};
use crate::chunk::{channel_rkey, plan_reader, read_chunk, release_rkey, ChunkedArtifact};
use crate::pipeline::{check_channel_move, classify_channel_move, DEFAULT_STAGES};
use crate::sign::{sign_release, SignedFields};
use crate::validate;
use anyhow::{Context, Result};
use bytes::Bytes;
use chrono::Utc;
use ed25519_dalek::SigningKey;
use indicatif::{ProgressBar, ProgressStyle};
use serde_json::{json, Value};
use std::fs::File;
use std::path::Path;

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
    /// OEM Ed25519 key; when set the release carries `oemSignature`.
    pub oem_key: Option<SigningKey>,
    pub oem_key_id: Option<String>,
    pub allow_downgrade: bool,
}

#[derive(Debug)]
pub struct PublishResult {
    pub release: StrongRef,
    pub chunk_count: u32,
    pub image_sha256: String,
    pub image_size: u64,
    pub rkey: String,
    pub channel_rkey: String,
    pub author_did: String,
    pub status: String,
    pub dry_run: bool,
    pub channel_updated: bool,
    pub oem_public_key: Option<String>,
    /// Non-fatal problems (optional records that could not be written).
    pub warnings: Vec<String>,
}

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Check everything that ends up in rkeys, records and the signed message.
pub fn validate_args(args: &PublishArgs) -> Result<()> {
    validate::validate_product(&args.product)?;
    validate::validate_version(&args.version)?;
    validate::validate_channel(&args.channel)?;
    validate::validate_kind(&args.kind)?;
    validate::validate_runtime(&args.runtime)?;
    for s in &args.required_pipeline_stages {
        validate::validate_stage(s)?;
    }
    Ok(())
}

/// Hash and lay out the artifact in one streaming pass (one chunk in memory).
pub fn plan_from_file(path: &Path, chunk_size: usize) -> Result<ChunkedArtifact> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    if !file.metadata()?.is_file() {
        anyhow::bail!("{} is not a regular file", path.display());
    }
    let plan = plan_reader(file, chunk_size).with_context(|| format!("read {}", path.display()))?;
    if plan.image_size == 0 {
        anyhow::bail!(
            "{} is empty; refusing to publish an empty artifact",
            path.display()
        );
    }
    Ok(plan)
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

fn exists_error(rkey: &str, cid: Option<&str>) -> anyhow::Error {
    anyhow::anyhow!(
        "release {rkey} already exists{}; releases are immutable — publish a new version",
        cid.map(|c| format!(" (cid {c})")).unwrap_or_default()
    )
}

fn existing_cid(client: &mut AtpClient, rkey: &str) -> Result<Option<String>> {
    let did = client.session.did.clone();
    Ok(client
        .get_record_opt(COLLECTION_RELEASE, rkey, &did)
        .with_context(|| format!("check whether release {rkey} already exists"))?
        .map(|r| {
            r.get("cid")
                .and_then(Value::as_str)
                .unwrap_or("?")
                .to_string()
        }))
}

pub fn publish(client: &mut AtpClient, args: &PublishArgs) -> Result<PublishResult> {
    validate_args(args)?;
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

    let did = client.session.did.clone();
    let rkey = release_rkey(&args.product, &args.version, &args.channel);
    let ch_rkey = channel_rkey(&args.product, &args.channel);
    let release_uri_preview = format!("at://{did}/{COLLECTION_RELEASE}/{rkey}");
    let chunk_count = plan.chunks.len() as u32; // bounded by MAX_PARTS

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
            author_did: Some(did.clone()),
        })
        .collect();
    let pre = ReleaseMeta {
        version: args.version.clone(),
        product: args.product.clone(),
        kind: args.kind.clone(),
        image_sha256: plan.image_sha256.clone(),
        image_size: plan.image_size,
        chunk_count,
        channel: args.channel.clone(),
        status: "ready".into(),
        author_did: did.clone(),
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

    // Releases are create-only: never replace a published product/version.
    if let Some(cid) = existing_cid(client, &rkey)? {
        return Err(exists_error(&rkey, Some(&cid)));
    }
    // Fail before uploading anything if the channel could not be moved.
    if args.skip_pipeline {
        check_channel(
            client,
            &args.product,
            &args.channel,
            &args.version,
            args.allow_downgrade,
        )?;
    }

    let next_status = if args.skip_pipeline {
        "ready"
    } else {
        "awaiting-pipeline"
    };
    let oem_signature = args.oem_key.as_ref().map(|key| {
        sign_release(
            key,
            &SignedFields {
                product: &args.product,
                version: &args.version,
                channel: &args.channel,
                image_sha256: &plan.image_sha256,
                image_size: plan.image_size,
            },
            args.oem_key_id.as_deref(),
        )
    });
    let oem_public_key = oem_signature.as_ref().map(|s| s.public_key.clone());

    if args.dry_run {
        hlog(args.quiet, "[dry-run] OK — no blobs or records written");
        return Ok(PublishResult {
            release: StrongRef {
                uri: release_uri_preview,
                cid: "dry-run".into(),
            },
            chunk_count,
            image_sha256: plan.image_sha256,
            image_size: plan.image_size,
            rkey,
            channel_rkey: ch_rkey,
            author_did: did,
            status: next_status.into(),
            dry_run: true,
            channel_updated: false,
            oem_public_key,
            warnings: Vec::new(),
        });
    }

    let require_pipeline = !args.skip_pipeline;
    let stages = if require_pipeline && args.required_pipeline_stages.is_empty() {
        DEFAULT_STAGES.iter().map(|s| s.to_string()).collect()
    } else {
        args.required_pipeline_stages.clone()
    };

    let pb = ProgressBar::new(plan.chunks.len() as u64);
    if args.quiet {
        pb.set_draw_target(indicatif::ProgressDrawTarget::hidden());
    }
    pb.set_style(
        ProgressStyle::with_template(
            "{spinner:.green} [{bar:40.cyan/blue}] {pos}/{len} parts {msg}",
        )
        .expect("static template")
        .progress_chars("=>-"),
    );

    // Re-read the file part by part; `read_chunk` rejects a file that changed
    // since it was planned, so the record always matches the uploaded bytes.
    let mut file =
        File::open(&args.file).with_context(|| format!("open {}", args.file.display()))?;
    let mut parts = Vec::with_capacity(plan.chunks.len());
    for c in &plan.chunks {
        pb.set_message(format!("seq {}", c.seq));
        let data = Bytes::from(read_chunk(&mut file, c)?);
        let blob = client
            .upload_blob(data, &args.mime_type)
            .with_context(|| format!("uploadBlob seq {}", c.seq))?;
        if blob.size != c.byte_length {
            anyhow::bail!(
                "PDS stored part {} as {} bytes, expected {}",
                c.seq,
                blob.size,
                c.byte_length
            );
        }
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
        "createdAt": now(),
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
    if let Some(sig) = &oem_signature {
        release_record["oemSignature"] = serde_json::to_value(sig)?;
    }

    hlog(args.quiet, format!("Creating immutable release {rkey}…"));
    let release_ref = match client.create_record(COLLECTION_RELEASE, release_record, Some(&rkey)) {
        Ok(r) => r,
        Err(e) => {
            // Lost a race with another publisher of the same version?
            return Err(match existing_cid(client, &rkey) {
                Ok(Some(cid)) => exists_error(&rkey, Some(&cid)),
                _ => e.context(format!("create release {rkey}")),
            });
        }
    };
    hlog(args.quiet, format!("  uri: {}", release_ref.uri));
    hlog(args.quiet, format!("  cid: {}", release_ref.cid));

    let recover = format!(
        "the release record {} WAS created; finish with `ofw pipeline-{} --rkey {rkey}`",
        release_ref.uri,
        if args.skip_pipeline {
            "skip"
        } else {
            "promote"
        }
    );
    write_gate(client, &rkey, &release_ref, next_status, None)
        .with_context(|| format!("write gate — {recover}"))?;

    let mut warnings = Vec::new();
    if args.skip_pipeline {
        move_channel(
            client,
            &args.product,
            &args.channel,
            &args.version,
            &release_ref,
            args.allow_downgrade,
        )
        .with_context(|| format!("update channel pointer — {recover}"))?;

        let seal = json!({
            "$type": COLLECTION_SEAL,
            "release": { "uri": release_ref.uri, "cid": release_ref.cid },
            "partCount": plan.chunks.len(),
            "imageSha256": plan.image_sha256,
            "createdAt": now(),
        });
        if let Err(e) = client.create_record(COLLECTION_SEAL, seal, None) {
            warnings.push(format!("release seal was not written: {e:#}"));
        }
    }

    if let Err(e) = ensure_declaration(client, &args.product) {
        warnings.push(format!(
            "actor declaration was not updated (product may not be discoverable): {e:#}"
        ));
    }
    // Warnings go to stderr even with --json; they are also in the JSON result.
    for w in &warnings {
        eprintln!("WARNING: {w}");
    }

    if require_pipeline {
        hlog(args.quiet, "Release uploaded — awaiting-pipeline.");
        hlog(
            args.quiet,
            format!("  Required stages: {}", stages.join(", ")),
        );
        hlog(
            args.quiet,
            format!(
                "  Next: ofw pipeline-ack --rkey {rkey} --stage {} --result passed",
                stages.first().map(String::as_str).unwrap_or("build")
            ),
        );
    } else {
        hlog(
            args.quiet,
            format!("Release ready (pipeline skipped). Channel {ch_rkey} updated."),
        );
    }
    hlog(args.quiet, format!("  author:  {did}"));
    hlog(args.quiet, format!("  gate:    {next_status}"));
    hlog(args.quiet, format!("  sha256:  {}", plan.image_sha256));
    if let Some(pk) = &oem_public_key {
        hlog(args.quiet, format!("  oem key: {pk} (Ed25519)"));
    }

    Ok(PublishResult {
        release: release_ref,
        chunk_count,
        image_sha256: plan.image_sha256,
        image_size: plan.image_size,
        rkey,
        channel_rkey: ch_rkey,
        author_did: did,
        status: next_status.to_string(),
        dry_run: false,
        channel_updated: args.skip_pipeline,
        oem_public_key,
        warnings,
    })
}

/// Create-or-replace a *mutable* sidecar record in the caller's own repo.
/// Replacement is a compare-and-swap on the CID that was read. Only a
/// RecordNotFound answer leads to a create; any other read failure is an error.
pub fn upsert(
    client: &mut AtpClient,
    collection: &str,
    rkey: &str,
    record: Value,
) -> Result<StrongRef> {
    let did = client.session.did.clone();
    match client.get_record_opt(collection, rkey, &did)? {
        Some(existing) => {
            let (_, cid, _) = record_parts(&existing, collection)?;
            client.put_record(collection, rkey, record, Some(&cid))
        }
        None => client.create_record(collection, record, Some(rkey)),
    }
}

pub fn write_gate(
    client: &mut AtpClient,
    rkey: &str,
    release: &StrongRef,
    state: &str,
    reason: Option<&str>,
) -> Result<StrongRef> {
    let mut gate = json!({
        "$type": COLLECTION_GATE,
        "release": { "uri": release.uri, "cid": release.cid },
        "state": state,
        "updatedAt": now(),
    });
    if let Some(r) = reason {
        gate["reason"] = json!(r);
    }
    upsert(client, COLLECTION_GATE, rkey, gate)
}

/// The channel pointer must not move (policy, not an I/O failure).
#[derive(Debug)]
pub struct ChannelRefused(pub String);

impl std::fmt::Display for ChannelRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ChannelRefused {}

/// Read the channel pointer and refuse a downgrade unless allowed. Returns
/// the CID to swap against when the pointer already exists.
fn check_channel(
    client: &mut AtpClient,
    product: &str,
    channel: &str,
    version: &str,
    allow_downgrade: bool,
) -> Result<Option<String>> {
    let did = client.session.did.clone();
    let ch_rkey = channel_rkey(product, channel);
    let existing = client
        .get_record_opt(COLLECTION_CHANNEL, &ch_rkey, &did)
        .with_context(|| format!("read channel pointer {ch_rkey}"))?;
    let Some(existing) = existing else {
        return Ok(None);
    };
    let (_, cid, value) = record_parts(&existing, "channel pointer")?;
    let current = value.get("version").and_then(Value::as_str);
    let mv = classify_channel_move(current, version);
    check_channel_move(&mv, version, allow_downgrade).map_err(|e| {
        anyhow::Error::new(ChannelRefused(format!(
            "refusing to move channel {ch_rkey}: {e}"
        )))
    })?;
    Ok(Some(cid))
}

/// Point `product`/`channel` at `release`, guarding against downgrades and
/// concurrent writers (swapRecord).
pub fn move_channel(
    client: &mut AtpClient,
    product: &str,
    channel: &str,
    version: &str,
    release: &StrongRef,
    allow_downgrade: bool,
) -> Result<StrongRef> {
    let swap = check_channel(client, product, channel, version, allow_downgrade)?;
    let ch_rkey = channel_rkey(product, channel);
    let record = json!({
        "$type": COLLECTION_CHANNEL,
        "product": product,
        "channel": channel,
        "release": { "uri": release.uri, "cid": release.cid },
        "version": version,
        "updatedAt": now(),
    });
    match swap {
        Some(cid) => client.put_record(COLLECTION_CHANNEL, &ch_rkey, record, Some(&cid)),
        None => client.create_record(COLLECTION_CHANNEL, record, Some(&ch_rkey)),
    }
}

/// Dry check used by promotion before it writes the gate.
pub fn ensure_channel_can_move(
    client: &mut AtpClient,
    product: &str,
    channel: &str,
    version: &str,
    allow_downgrade: bool,
) -> Result<()> {
    check_channel(client, product, channel, version, allow_downgrade).map(|_| ())
}

fn ensure_declaration(client: &mut AtpClient, product: &str) -> Result<()> {
    let did = client.session.did.clone();
    match client.get_record_opt(COLLECTION_DECLARATION, "self", &did)? {
        Some(existing) => {
            let (_, cid, mut value) = record_parts(&existing, "declaration")?;
            let mut products: Vec<String> = value
                .get("products")
                .and_then(|p| p.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            if products.iter().any(|p| p == product) {
                return Ok(());
            }
            products.push(product.to_string());
            if !value.is_object() {
                value = json!({});
            }
            value["$type"] = json!(COLLECTION_DECLARATION);
            value["products"] = json!(products);
            client.put_record(COLLECTION_DECLARATION, "self", value, Some(&cid))?;
        }
        None => {
            client.create_record(
                COLLECTION_DECLARATION,
                json!({
                    "$type": COLLECTION_DECLARATION,
                    "products": [product],
                    "createdAt": now(),
                }),
                Some("self"),
            )?;
        }
    }
    Ok(())
}

pub fn result_json(res: &PublishResult) -> Value {
    let mut out = json!({
        "uri": res.release.uri,
        "cid": res.release.cid,
        "rkey": res.rkey,
        "authorDid": res.author_did,
        "partCount": res.chunk_count,
        "imageSha256": res.image_sha256,
        "imageSize": res.image_size,
        "gate": res.status,
        "dryRun": res.dry_run,
        "channelRkey": res.channel_rkey,
        "channelUpdated": res.channel_updated,
        "oemSigned": res.oem_public_key.is_some(),
        "warnings": res.warnings,
    });
    if let Some(pk) = &res.oem_public_key {
        out["oemPublicKey"] = json!(pk);
    }
    out
}
