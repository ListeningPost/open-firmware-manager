//! Post CI acknowledgments and promote the gate + channel sidecars.

use crate::atproto::{
    AtpClient, COLLECTION_CHANNEL, COLLECTION_GATE, COLLECTION_PIPELINE_ACK, COLLECTION_RELEASE,
};
use crate::chunk::channel_rkey;
use crate::publish::upsert;
use anyhow::{Context, Result};
use chrono::Utc;
use clap::{Args, Subcommand};
use serde_json::json;

#[derive(Debug, Subcommand)]
pub enum PipelineCmd {
    Ack(AckArgs),
    Skip(SkipArgs),
    Promote(PromoteArgs),
}

#[derive(Debug, Args)]
pub struct AckArgs {
    #[arg(long, env = "OFW_PDS")]
    pub pds: String,
    #[arg(long, env = "OFW_IDENTIFIER")]
    pub identifier: String,
    #[arg(long, env = "OFW_PASSWORD")]
    pub password: String,
    #[arg(long)]
    pub rkey: String,
    /// Publisher DID when CI is a different account (acks go in the CI repo).
    #[arg(long, env = "OFW_AUTHOR_DID")]
    pub author_did: Option<String>,
    #[arg(long)]
    pub stage: String,
    #[arg(long)]
    pub stage_id: Option<String>,
    #[arg(long)]
    pub result: String,
    #[arg(long)]
    pub run_url: Option<String>,
    #[arg(long)]
    pub commit: Option<String>,
    #[arg(long)]
    pub summary: Option<String>,
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

#[derive(Debug, Args)]
pub struct PromoteArgs {
    #[arg(long, env = "OFW_PDS")]
    pub pds: String,
    #[arg(long, env = "OFW_IDENTIFIER")]
    pub identifier: String,
    #[arg(long, env = "OFW_PASSWORD")]
    pub password: String,
    #[arg(long)]
    pub rkey: String,
    /// Comma-separated CI DIDs whose pipelineAck records are required.
    #[arg(long = "attester-did", env = "OFW_ATTESTER_DIDS", value_delimiter = ',')]
    pub attester_dids: Vec<String>,
    #[arg(long)]
    pub json: bool,
}

pub fn run(cmd: PipelineCmd) -> Result<()> {
    match cmd {
        PipelineCmd::Ack(a) => run_ack(a),
        PipelineCmd::Skip(s) => run_skip(s),
        PipelineCmd::Promote(p) => run_promote(p),
    }
}

fn run_ack(a: AckArgs) -> Result<()> {
    let result = a.result.to_lowercase();
    if !matches!(result.as_str(), "passed" | "failed" | "skipped") {
        anyhow::bail!("--result must be passed|failed|skipped");
    }
    let mut client = AtpClient::login(&a.pds, &a.identifier, &a.password)?;
    let author = a
        .author_did
        .clone()
        .unwrap_or_else(|| client.session.did.clone());
    let rec = client
        .get_record(COLLECTION_RELEASE, &a.rkey, Some(&author))
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
    if !a.json {
        eprintln!("pipeline-ack recorded: {}", ack_ref.uri);
    }

    let can_write_gate = author == client.session.did;
    if result == "failed" {
        if !can_write_gate {
            if !a.json {
                eprintln!("ack recorded in CI repo; publisher must fail the gate");
            }
        } else {
        upsert(
            &mut client,
            COLLECTION_GATE,
            &a.rkey,
            json!({
                "$type": COLLECTION_GATE,
                "release": { "uri": uri, "cid": cid },
                "state": "failed",
                "updatedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                "reason": format!("stage {} failed", a.stage),
            }),
        )?;
        if !a.json {
            eprintln!("gate marked failed");
        }
        }
    } else if can_write_gate && !a.no_promote {
        if try_promote(&mut client, &a.rkey, &value, &uri, &cid, &[])? {
            if !a.json {
                eprintln!("all required stages ok — gate ready + channel updated");
            }
        } else if !a.json {
            eprintln!("ack stored; still waiting for other stages.");
        }
    }

    if a.json {
        println!(
            "{}",
            serde_json::to_string(&json!({
                "ackUri": ack_ref.uri,
                "ackCid": ack_ref.cid,
                "rkey": a.rkey,
                "stage": a.stage,
                "result": result,
                "actor": client.session.did,
                "authorDid": author,
                "promoted": can_write_gate && !a.no_promote,
            }))?
        );
    }
    Ok(())
}

fn try_promote(
    client: &mut AtpClient,
    rkey: &str,
    value: &serde_json::Value,
    release_uri: &str,
    release_cid: &str,
    attester_dids: &[String],
) -> Result<bool> {
    let require = value
        .get("requirePipelineAcks")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let policy = value
        .get("pipelinePolicy")
        .and_then(|v| v.as_str())
        .unwrap_or(if require { "strict" } else { "skipped" });

    let stages: Vec<String> = value
        .get("requiredPipelineStages")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_else(|| vec!["build".into(), "test".into()]);

    if policy != "skipped" && require {
        let repos: Vec<String> = if attester_dids.is_empty() {
            vec![client.session.did.clone()]
        } else {
            attester_dids.to_vec()
        };
        let mut records = Vec::new();
        for repo in &repos {
            records.extend(client.list_records(COLLECTION_PIPELINE_ACK, repo)?);
        }
        let mut latest: std::collections::BTreeMap<String, String> =
            std::collections::BTreeMap::new();
        let mut items: Vec<_> = records
            .iter()
            .filter(|r| {
                r.pointer("/value/release/uri")
                    .and_then(|u| u.as_str())
                    == Some(release_uri)
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
                return Ok(false);
            }
        }
    }

    upsert(
        client,
        COLLECTION_GATE,
        rkey,
        json!({
            "$type": COLLECTION_GATE,
            "release": { "uri": release_uri, "cid": release_cid },
            "state": "ready",
            "updatedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }),
    )?;
    let product = value.get("product").and_then(|v| v.as_str()).unwrap_or("");
    let channel = value
        .get("channel")
        .and_then(|v| v.as_str())
        .unwrap_or("stable");
    let version = value.get("version").and_then(|v| v.as_str()).unwrap_or("");
    upsert(
        client,
        COLLECTION_CHANNEL,
        &channel_rkey(product, channel),
        json!({
            "$type": COLLECTION_CHANNEL,
            "product": product,
            "channel": channel,
            "release": { "uri": release_uri, "cid": release_cid },
            "version": version,
            "updatedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }),
    )?;
    Ok(true)
}

fn run_skip(s: SkipArgs) -> Result<()> {
    let mut client = AtpClient::login(&s.pds, &s.identifier, &s.password)?;
    let rec = client.get_record(COLLECTION_RELEASE, &s.rkey, Some(&client.session.did.clone()))?;
    let uri = rec.get("uri").and_then(|v| v.as_str()).unwrap_or("");
    let cid = rec.get("cid").and_then(|v| v.as_str()).unwrap_or("");
    let value = rec.get("value").cloned().context("release missing value")?;
    try_promote(&mut client, &s.rkey, &value, uri, cid, &[])?;
    if !s.json {
        eprintln!("pipeline skipped — gate ready: {uri}");
    }
    if s.json {
        println!(
            "{}",
            serde_json::to_string(&json!({
                "uri": uri,
                "cid": cid,
                "rkey": s.rkey,
                "gate": "ready",
            }))?
        );
    }
    Ok(())
}

fn run_promote(p: PromoteArgs) -> Result<()> {
    let mut client = AtpClient::login(&p.pds, &p.identifier, &p.password)?;
    let rec = client
        .get_record(COLLECTION_RELEASE, &p.rkey, Some(&client.session.did.clone()))
        .context("load release")?;
    let uri = rec.get("uri").and_then(|v| v.as_str()).unwrap_or("");
    let cid = rec.get("cid").and_then(|v| v.as_str()).unwrap_or("");
    let value = rec.get("value").cloned().context("release missing value")?;
    let ok = try_promote(
        &mut client,
        &p.rkey,
        &value,
        uri,
        cid,
        &p.attester_dids,
    )?;
    if !ok {
        anyhow::bail!("required pipeline acks not present yet");
    }
    if p.json {
        println!(
            "{}",
            serde_json::to_string(&json!({
                "uri": uri,
                "cid": cid,
                "rkey": p.rkey,
                "gate": "ready",
                "attesterDids": p.attester_dids,
            }))?
        );
    } else {
        eprintln!("promoted — gate ready + channel updated: {uri}");
    }
    Ok(())
}
