//! Post CI/build/test acknowledgments and promote releases.

use crate::atproto::{AtpClient, COLLECTION_PIPELINE_ACK, COLLECTION_RELEASE};
use anyhow::{Context, Result};
use chrono::Utc;
use clap::{Args, Subcommand};
use serde_json::json;

#[derive(Debug, Subcommand)]
pub enum PipelineCmd {
    /// Acknowledge a pipeline stage (build, test, …)
    Ack(AckArgs),
    /// Skip remaining pipeline checks and mark release ready
    Skip(SkipArgs),
}

#[derive(Debug, Args)]
pub struct AckArgs {
    #[arg(long, env = "OFW_PDS")]
    pub pds: String,
    #[arg(long, env = "OFW_IDENTIFIER")]
    pub identifier: String,
    #[arg(long, env = "OFW_PASSWORD")]
    pub password: String,
    /// Release rkey (product-version-channel)
    #[arg(long)]
    pub rkey: String,
    /// Stage name: build | test | lint | security_scan | sign | promote | custom
    #[arg(long)]
    pub stage: String,
    #[arg(long)]
    pub stage_id: Option<String>,
    /// passed | failed | skipped
    #[arg(long)]
    pub result: String,
    #[arg(long)]
    pub run_url: Option<String>,
    #[arg(long)]
    pub commit: Option<String>,
    #[arg(long)]
    pub summary: Option<String>,
    /// Do not auto-promote to ready when all stages pass
    #[arg(long)]
    pub no_promote: bool,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct SkipArgs {
    #[arg(long, env = "OFW_PDS")]
    pub pds: String,
    #[arg(long, env = "OFW_IDENTIFIER")]
    pub identifier: String,
    #[arg(long, env = "OFW_PASSWORD")]
    pub password: String,
    #[arg(long)]
    pub rkey: String,
    #[arg(long)]
    pub json: bool,
}

pub fn run(cmd: PipelineCmd) -> Result<()> {
    match cmd {
        PipelineCmd::Ack(a) => run_ack(a),
        PipelineCmd::Skip(s) => run_skip(s),
    }
}

fn run_ack(a: AckArgs) -> Result<()> {
    let result = a.result.to_lowercase();
    if !matches!(result.as_str(), "passed" | "failed" | "skipped") {
        anyhow::bail!("--result must be passed|failed|skipped");
    }
    let client = AtpClient::login(&a.pds, &a.identifier, &a.password)?;
    let rec = client
        .get_record(COLLECTION_RELEASE, &a.rkey, Some(&client.session.did))
        .context("load release")?;
    let uri = rec
        .get("uri")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cid = rec
        .get("cid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let value = rec
        .get("value")
        .cloned()
        .context("release missing value")?;

    let mut ack = json!({
        "$type": COLLECTION_PIPELINE_ACK,
        "release": { "uri": uri, "cid": cid },
        "stage": a.stage,
        "result": result,
        "createdAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "actor": client.session.did,
    });
    if let Some(id) = &a.stage_id {
        ack["stageId"] = json!(id);
    }
    if let Some(u) = &a.run_url {
        ack["runUrl"] = json!(u);
    }
    if let Some(c) = &a.commit {
        ack["commit"] = json!(c);
    }
    if let Some(s) = &a.summary {
        ack["summary"] = json!(s);
    }

    let ack_ref = client.create_record(COLLECTION_PIPELINE_ACK, ack, None)?;
    println!("pipeline-ack recorded: {}", ack_ref.uri);

    if result == "failed" {
        let mut v = value.clone();
        v["status"] = json!("failed");
        let r = client.put_record(COLLECTION_RELEASE, &a.rkey, v)?;
        println!("release marked failed: {}", r.uri);
    } else if !a.no_promote {
        if let Some(promoted) = try_promote(&client, &a.rkey, &value, &uri)? {
            println!("all required stages ok — promoted to ready: {}", promoted.uri);
        } else {
            println!("ack stored; still waiting for other stages (or already ready).");
        }
    }

    if a.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "ackUri": ack_ref.uri,
                "ackCid": ack_ref.cid,
                "rkey": a.rkey,
                "stage": a.stage,
                "result": result,
            }))?
        );
    }
    Ok(())
}

fn try_promote(
    client: &AtpClient,
    rkey: &str,
    value: &serde_json::Value,
    release_uri: &str,
) -> Result<Option<crate::atproto::StrongRef>> {
    if value.get("status").and_then(|s| s.as_str()) == Some("ready") {
        return Ok(None);
    }
    let require = value
        .get("requirePipelineAcks")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let policy = value
        .get("pipelinePolicy")
        .and_then(|v| v.as_str())
        .unwrap_or(if require { "strict" } else { "skipped" });
    if policy == "skipped" || !require {
        let mut v = value.clone();
        v["status"] = json!("ready");
        return Ok(Some(client.put_record(COLLECTION_RELEASE, rkey, v)?));
    }

    let stages: Vec<String> = value
        .get("requiredPipelineStages")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_else(|| vec!["build".into(), "test".into()]);

    let listed = client.list_records(COLLECTION_PIPELINE_ACK, &client.session.did, 100)?;
    let records = listed
        .get("records")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();

    let mut latest: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    let mut items: Vec<_> = records
        .iter()
        .filter(|r| {
            r.pointer("/value/release/uri")
                .and_then(|u| u.as_str())
                .map(|u| u == release_uri)
                .unwrap_or(false)
        })
        .collect();
    items.sort_by_key(|r| {
        r.pointer("/value/createdAt")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string()
    });
    for r in items {
        let stage = r
            .pointer("/value/stage")
            .and_then(|s| s.as_str())
            .unwrap_or("");
        let result = r
            .pointer("/value/result")
            .and_then(|s| s.as_str())
            .unwrap_or("");
        latest.insert(stage.to_string(), result.to_string());
    }

    for s in &stages {
        let r = latest.get(s).map(|s| s.as_str()).unwrap_or("");
        if r != "passed" && r != "skipped" {
            return Ok(None);
        }
    }

    let mut v = value.clone();
    v["status"] = json!("ready");
    Ok(Some(client.put_record(COLLECTION_RELEASE, rkey, v)?))
}

fn run_skip(s: SkipArgs) -> Result<()> {
    let client = AtpClient::login(&s.pds, &s.identifier, &s.password)?;
    let rec = client.get_record(COLLECTION_RELEASE, &s.rkey, Some(&client.session.did))?;
    let mut value = rec
        .get("value")
        .cloned()
        .context("release missing value")?;
    value["status"] = json!("ready");
    value["requirePipelineAcks"] = json!(false);
    value["pipelinePolicy"] = json!("skipped");
    let r = client.put_record(COLLECTION_RELEASE, &s.rkey, value)?;
    println!("pipeline skipped — release ready: {}", r.uri);
    if s.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "uri": r.uri,
                "cid": r.cid,
                "rkey": s.rkey,
                "status": "ready",
                "pipelinePolicy": "skipped",
            }))?
        );
    }
    Ok(())
}
