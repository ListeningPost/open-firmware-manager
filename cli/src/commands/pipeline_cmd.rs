//! Post CI acknowledgments and promote the gate + channel sidecars.

use crate::atproto::{
    record_parts, AtpClient, StrongRef, COLLECTION_GATE, COLLECTION_PIPELINE_ACK,
    COLLECTION_RELEASE,
};
use crate::chunk::channel_rkey;
use crate::commands::common::{login, LoginArgs, PdsArgs};
use crate::pipeline::{
    ack_from_record, decide_promotion, decide_skip, evaluate_acks, release_policy, Ack, Decision,
    GateView, Policy,
};
use crate::publish::{ensure_channel_can_move, move_channel, now, write_gate, ChannelRefused};
use crate::validate::{validate_ack_result, validate_stage};
use anyhow::{Context, Result};
use clap::Args;
use serde_json::{json, Value};

#[derive(Debug, Args)]
pub struct AckArgs {
    #[command(flatten)]
    pub pds: PdsArgs,
    #[command(flatten)]
    pub login: LoginArgs,
    /// Release record key (`rkey` from `ofw publish --json`)
    #[arg(long)]
    pub rkey: String,
    /// Publisher DID when CI is a different account (acks go in the CI repo).
    #[arg(long, env = "OFW_AUTHOR_DID")]
    pub author_did: Option<String>,
    /// build | test | lint | security-scan | sign | promote | custom
    #[arg(long)]
    pub stage: String,
    /// Name of a `custom` stage (the required stage is then `custom:<id>`)
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
    /// Only record the ack; never try to promote
    #[arg(long)]
    pub no_promote: bool,
    /// When auto-promoting as the publisher, count only acks from these DIDs
    #[arg(
        long = "attester-did",
        env = "OFW_ATTESTER_DIDS",
        value_delimiter = ','
    )]
    pub attester_dids: Vec<String>,
    /// Let an auto-promotion move the channel to an older version
    #[arg(long)]
    pub allow_downgrade: bool,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct SkipArgs {
    #[command(flatten)]
    pub pds: PdsArgs,
    #[command(flatten)]
    pub login: LoginArgs,
    #[arg(long)]
    pub rkey: String,
    /// Also force a release whose gate is `failed`
    #[arg(long)]
    pub override_failed: bool,
    /// Let the channel pointer move to an older version than it names now
    #[arg(long)]
    pub allow_downgrade: bool,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct PromoteArgs {
    #[command(flatten)]
    pub pds: PdsArgs,
    #[command(flatten)]
    pub login: LoginArgs,
    #[arg(long)]
    pub rkey: String,
    /// Comma-separated CI DIDs whose pipelineAck records are required.
    /// Without it, only acks in the publisher's own repo count (self-attested).
    #[arg(
        long = "attester-did",
        env = "OFW_ATTESTER_DIDS",
        value_delimiter = ','
    )]
    pub attester_dids: Vec<String>,
    /// Let the channel pointer move to an older version than it names now
    #[arg(long)]
    pub allow_downgrade: bool,
    #[arg(long)]
    pub json: bool,
}

/// A release record the logged-in publisher owns, with the fields promotion needs.
struct OwnRelease {
    strong: StrongRef,
    value: Value,
    product: String,
    version: String,
    channel: String,
}

fn load_release(client: &mut AtpClient, rkey: &str, repo: &str) -> Result<(StrongRef, Value)> {
    let rec = client
        .get_record(COLLECTION_RELEASE, rkey, repo)
        .with_context(|| format!("load release {rkey} from {repo}"))?;
    let (uri, cid, value) = record_parts(&rec, "release")?;
    Ok((StrongRef { uri, cid }, value))
}

fn load_own_release(client: &mut AtpClient, rkey: &str) -> Result<OwnRelease> {
    let did = client.session.did.clone();
    let (strong, value) = load_release(client, rkey, &did)?;
    let field = |name: &str| -> Result<String> {
        value
            .get(name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .with_context(|| format!("release {rkey} has no {name}"))
    };
    Ok(OwnRelease {
        product: field("product")?,
        version: field("version")?,
        channel: value
            .get("channel")
            .and_then(Value::as_str)
            .unwrap_or("stable")
            .to_string(),
        strong,
        value,
    })
}

fn load_gate(client: &mut AtpClient, rkey: &str) -> Result<Option<GateView>> {
    let did = client.session.did.clone();
    Ok(client
        .get_record_opt(COLLECTION_GATE, rkey, &did)
        .with_context(|| format!("load gate {rkey}"))?
        .map(|g| GateView::from_record_value(g.get("value").unwrap_or(&Value::Null))))
}

fn clean_dids(dids: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for d in dids.iter().map(|d| d.trim()).filter(|d| !d.is_empty()) {
        if !d.starts_with("did:") {
            anyhow::bail!("--attester-did {d:?} is not a DID");
        }
        if !out.iter().any(|x| x == d) {
            out.push(d.to_string());
        }
    }
    Ok(out)
}

#[derive(Debug)]
enum Outcome {
    Promoted,
    Waiting { missing: Vec<String> },
    Refused(String),
}

struct Promotion {
    outcome: Outcome,
    release: StrongRef,
    channel_rkey: String,
    policy: Policy,
    /// Acks were required and only the publisher's own repo was consulted.
    self_attested: bool,
    attesters: Vec<String>,
}

fn warn_self_attested(rkey: &str) {
    eprintln!(
        "WARNING: no independent --attester-did for {rkey}: only acks in the publisher's OWN \
         repo are counted, so this pipeline gate is self-attested and proves nothing about \
         independent CI. Pass --attester-did <CI DID> (OFW_ATTESTER_DIDS)."
    );
}

/// Ack-driven promotion: decide from the stored gate and the acks, and only
/// then write gate=ready and move the channel.
fn promote(
    client: &mut AtpClient,
    rkey: &str,
    attester_dids: &[String],
    allow_downgrade: bool,
) -> Result<Promotion> {
    let rel = load_own_release(client, rkey)?;
    let policy = release_policy(&rel.value);
    let gate = load_gate(client, rkey)?;
    let attesters = clean_dids(attester_dids)?;
    let me = client.session.did.clone();
    // Naming your own DID as the attester is still self-attestation.
    let self_attested = policy.policy == Policy::Strict && attesters.iter().all(|d| *d == me);

    let eval = if policy.policy == Policy::Strict {
        if self_attested {
            warn_self_attested(rkey);
        }
        let repos = if attesters.is_empty() {
            vec![me.clone()]
        } else {
            attesters.clone()
        };
        let mut acks: Vec<Ack> = Vec::new();
        for repo in &repos {
            let listed = client
                .list_records(COLLECTION_PIPELINE_ACK, repo)
                .with_context(|| format!("list pipeline acks in {repo}"))?;
            acks.extend(listed.iter().filter_map(|r| ack_from_record(r, repo)));
        }
        let eval = evaluate_acks(&rel.strong, &policy.stages, &acks, &repos);
        if !eval.cid_mismatch.is_empty() {
            eprintln!(
                "note: ack(s) for stage(s) {} name this release URI but a different (or no) \
                 release CID; they do not count",
                eval.cid_mismatch.join(", ")
            );
        }
        Some(eval)
    } else {
        None
    };

    let mut outcome = match decide_promotion(&policy, gate.as_ref(), &rel.strong, eval.as_ref()) {
        Decision::Promote => Outcome::Promoted,
        Decision::Wait { missing } => Outcome::Waiting { missing },
        Decision::Refuse(why) => Outcome::Refused(why),
    };

    if matches!(outcome, Outcome::Promoted) {
        // Check the channel first so a refused downgrade leaves the gate untouched.
        match ensure_channel_can_move(
            client,
            &rel.product,
            &rel.channel,
            &rel.version,
            allow_downgrade,
        ) {
            Ok(()) => {
                let reason = self_attested.then_some("promoted on self-attested acks");
                write_gate(client, rkey, &rel.strong, "ready", reason)?;
                move_channel(
                    client,
                    &rel.product,
                    &rel.channel,
                    &rel.version,
                    &rel.strong,
                    allow_downgrade,
                )
                .context("gate is ready but the channel pointer was not moved; re-run")?;
            }
            Err(e) if e.downcast_ref::<ChannelRefused>().is_some() => {
                outcome = Outcome::Refused(format!("{e:#}"))
            }
            Err(e) => return Err(e),
        }
    }

    Ok(Promotion {
        outcome,
        channel_rkey: channel_rkey(&rel.product, &rel.channel),
        release: rel.strong,
        policy: policy.policy,
        self_attested,
        attesters,
    })
}

pub fn run_ack(a: AckArgs) -> Result<()> {
    let result = a.result.to_lowercase();
    validate_ack_result(&result)?;
    validate_stage(&a.stage)?;
    if let Some(id) = &a.stage_id {
        validate_stage(id)?;
    }

    let mut client = login(&a.pds, &a.login)?;
    let me = client.session.did.clone();
    let author = a
        .author_did
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| me.clone());
    let (release, _) = load_release(&mut client, &a.rkey, &author)?;

    // The ack is a strongRef: it covers exactly this record version (URI + CID).
    let mut ack = json!({
        "$type": COLLECTION_PIPELINE_ACK,
        "release": { "uri": release.uri, "cid": release.cid },
        "stage": a.stage,
        "result": result,
        "createdAt": now(),
        "actor": me,
    });
    for (key, val) in [
        ("stageId", &a.stage_id),
        ("runUrl", &a.run_url),
        ("commit", &a.commit),
        ("summary", &a.summary),
    ] {
        if let Some(v) = val {
            ack[key] = json!(v);
        }
    }
    let ack_ref = client.create_record(COLLECTION_PIPELINE_ACK, ack, None)?;
    if !a.json {
        eprintln!("pipeline-ack recorded: {}", ack_ref.uri);
    }

    let can_write_gate = author == me;
    let mut out = json!({
        "ackUri": ack_ref.uri,
        "ackCid": ack_ref.cid,
        "rkey": a.rkey,
        "stage": a.stage,
        "result": result,
        "actor": me,
        "authorDid": author,
        "releaseCid": release.cid,
        "promoted": false,
        // Gate state after this command, when this account can know it.
        "gate": Value::Null,
        "promotion": "not-attempted",
    });

    if !can_write_gate {
        if !a.json {
            eprintln!(
                "ack stored in the CI repo; the publisher runs `ofw pipeline-promote \
                 --rkey {} --attester-did {me}`",
                a.rkey
            );
        }
    } else if result == "failed" {
        let reason = format!("stage {} failed", a.stage);
        write_gate(&mut client, &a.rkey, &release, "failed", Some(&reason))?;
        out["gate"] = json!("failed");
        if !a.json {
            eprintln!("gate marked failed");
        }
    } else if !a.no_promote {
        let p = promote(&mut client, &a.rkey, &a.attester_dids, a.allow_downgrade)?;
        out["selfAttested"] = json!(p.self_attested);
        match p.outcome {
            Outcome::Promoted => {
                out["promoted"] = json!(true);
                out["promotion"] = json!("promoted");
                out["gate"] = json!("ready");
                out["channelRkey"] = json!(p.channel_rkey);
                if !a.json {
                    eprintln!("all required stages ok — gate ready + channel updated");
                }
            }
            Outcome::Waiting { missing } => {
                out["promotion"] = json!("waiting");
                out["missingStages"] = json!(missing);
                if !a.json {
                    eprintln!("ack stored; still waiting for: {}", missing.join(", "));
                }
            }
            Outcome::Refused(why) => {
                out["promotion"] = json!("refused");
                out["promotionRefused"] = json!(why);
                eprintln!("WARNING: ack stored, but the release was NOT promoted: {why}");
            }
        }
    }

    if a.json {
        println!("{}", serde_json::to_string(&out)?);
    }
    Ok(())
}

pub fn run_skip(s: SkipArgs) -> Result<()> {
    let mut client = login(&s.pds, &s.login)?;
    let rel = load_own_release(&mut client, &s.rkey)?;
    let gate = load_gate(&mut client, &s.rkey)?;
    let previous = gate.as_ref().map(|g| g.state.clone());

    decide_skip(gate.as_ref(), &rel.strong, s.override_failed)
        .map_err(|why| anyhow::anyhow!("not skipping {}: {why}", s.rkey))?;
    ensure_channel_can_move(
        &mut client,
        &rel.product,
        &rel.channel,
        &rel.version,
        s.allow_downgrade,
    )?;

    // Explicit force path: the gate is written regardless of acks, and says so.
    write_gate(
        &mut client,
        &s.rkey,
        &rel.strong,
        "ready",
        Some("pipeline skipped by publisher"),
    )?;
    move_channel(
        &mut client,
        &rel.product,
        &rel.channel,
        &rel.version,
        &rel.strong,
        s.allow_downgrade,
    )
    .context("gate is ready but the channel pointer was not moved; re-run")?;

    let ch_rkey = channel_rkey(&rel.product, &rel.channel);
    if s.json {
        println!(
            "{}",
            serde_json::to_string(&json!({
                "uri": rel.strong.uri,
                "cid": rel.strong.cid,
                "rkey": s.rkey,
                "gate": "ready",
                "previousGate": previous,
                "forced": true,
                "channelRkey": ch_rkey,
            }))?
        );
    } else {
        eprintln!(
            "pipeline skipped — gate forced to ready (was {}), channel {ch_rkey} updated: {}",
            previous.as_deref().unwrap_or("missing"),
            rel.strong.uri
        );
    }
    Ok(())
}

pub fn run_promote(p: PromoteArgs) -> Result<()> {
    let mut client = login(&p.pds, &p.login)?;
    let res = promote(&mut client, &p.rkey, &p.attester_dids, p.allow_downgrade)?;
    match res.outcome {
        Outcome::Promoted => {}
        Outcome::Waiting { missing } => anyhow::bail!(
            "not promoted: required pipeline acks not present yet (missing: {})",
            missing.join(", ")
        ),
        Outcome::Refused(why) => anyhow::bail!("not promoted: {why}"),
    }
    if p.json {
        println!(
            "{}",
            serde_json::to_string(&json!({
                "uri": res.release.uri,
                "cid": res.release.cid,
                "rkey": p.rkey,
                "gate": "ready",
                "promoted": true,
                "policy": res.policy.as_str(),
                "channelRkey": res.channel_rkey,
                "attesterDids": res.attesters,
                "selfAttested": res.self_attested,
            }))?
        );
    } else {
        eprintln!(
            "promoted — gate ready + channel {} updated: {}",
            res.channel_rkey, res.release.uri
        );
    }
    Ok(())
}
