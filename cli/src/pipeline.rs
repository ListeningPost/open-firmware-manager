//! Pipeline gate decision logic — pure, no network.
//!
//! Mirrors `packages/core/src/pipeline` and `tryPromoteRelease` in
//! `packages/host`: an ack only counts when its `release` strongRef names the
//! exact release record version (URI *and* CID) and it was written by an
//! accepted attester.

use crate::atproto::{parse_at_uri, StrongRef};
use chrono::{DateTime, FixedOffset};
use serde_json::Value;
use std::collections::BTreeMap;

pub const DEFAULT_STAGES: [&str; 2] = ["build", "test"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Skipped,
    Optional,
    Strict,
}

impl Policy {
    pub fn as_str(self) -> &'static str {
        match self {
            Policy::Skipped => "skipped",
            Policy::Optional => "optional",
            Policy::Strict => "strict",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleasePolicy {
    pub policy: Policy,
    /// Stages that need a passed/skipped ack (empty unless `Strict`).
    pub stages: Vec<String>,
}

/// Read the pipeline policy a release record declares. An unknown policy
/// string must not weaken the gate, so it is treated as `strict`.
pub fn release_policy(value: &Value) -> ReleasePolicy {
    let require = value
        .get("requirePipelineAcks")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let policy = match value.get("pipelinePolicy").and_then(Value::as_str) {
        Some("skipped") => Policy::Skipped,
        Some("optional") => Policy::Optional,
        Some(_) => Policy::Strict,
        None if require => Policy::Strict,
        None => Policy::Skipped,
    };
    let stages = if policy == Policy::Strict {
        let declared: Vec<String> = value
            .get("requiredPipelineStages")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        if declared.is_empty() {
            DEFAULT_STAGES.iter().map(|s| s.to_string()).collect()
        } else {
            declared
        }
    } else {
        Vec::new()
    };
    ReleasePolicy { policy, stages }
}

/// One pipelineAck record, reduced to what the gate decision needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ack {
    /// DID of the repo the ack record lives in (from its AT-URI) — not the
    /// self-declared `actor` field.
    pub author_did: String,
    pub release_uri: String,
    pub release_cid: Option<String>,
    pub stage_key: String,
    pub result: String,
    pub created_at: String,
}

/// `custom` stages are keyed by their `stageId`, like `stageKey()` in core.
pub fn stage_key(stage: &str, stage_id: Option<&str>) -> String {
    match stage_id {
        Some(id) if stage == "custom" && !id.is_empty() => format!("custom:{id}"),
        _ => stage.to_string(),
    }
}

/// Decode a `listRecords` entry fetched from `listed_repo`. Entries whose
/// AT-URI does not belong to that repo, or that lack the required fields, are
/// dropped.
pub fn ack_from_record(rec: &Value, listed_repo: &str) -> Option<Ack> {
    let (did, _, _) = parse_at_uri(rec.get("uri")?.as_str()?)?;
    if did != listed_repo {
        return None;
    }
    let v = rec.get("value")?;
    let stage = v.get("stage")?.as_str()?;
    Some(Ack {
        author_did: did,
        release_uri: v.pointer("/release/uri")?.as_str()?.to_string(),
        release_cid: v
            .pointer("/release/cid")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .map(String::from),
        stage_key: stage_key(stage, v.get("stageId").and_then(Value::as_str)),
        result: v.get("result")?.as_str()?.to_string(),
        created_at: v
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AckEval {
    /// Required stages with no counting passed/skipped ack.
    pub missing: Vec<String>,
    /// Required stages whose latest counting ack is `failed`.
    pub failed: Vec<String>,
    /// Required stages that do have an ack for this release URI from an
    /// accepted attester, but bound to another (or no) release CID — i.e. the
    /// ack was issued for different bytes. Informational; such stages are
    /// also listed in `missing`.
    pub cid_mismatch: Vec<String>,
}

#[cfg(test)]
impl AckEval {
    pub fn satisfied(&self) -> bool {
        self.missing.is_empty() && self.failed.is_empty()
    }
}

fn parse_time(s: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(s).ok()
}

/// Evaluate acks for `release`. Only acks written by one of `attesters`
/// count; per stage the newest ack wins (unparseable timestamps sort oldest).
pub fn evaluate_acks(
    release: &StrongRef,
    stages: &[String],
    acks: &[Ack],
    attesters: &[String],
) -> AckEval {
    let mut for_uri: Vec<&Ack> = acks
        .iter()
        .filter(|a| a.release_uri == release.uri && attesters.contains(&a.author_did))
        .collect();
    for_uri.sort_by(|a, b| {
        (parse_time(&a.created_at), &a.created_at).cmp(&(parse_time(&b.created_at), &b.created_at))
    });

    let mut latest: BTreeMap<&str, &str> = BTreeMap::new();
    let mut other_cid: Vec<&str> = Vec::new();
    for a in for_uri {
        if a.release_cid.as_deref() == Some(release.cid.as_str()) {
            latest.insert(&a.stage_key, &a.result);
        } else {
            other_cid.push(&a.stage_key);
        }
    }

    let mut eval = AckEval::default();
    for s in stages {
        match latest.get(s.as_str()).copied() {
            Some("passed") | Some("skipped") => {}
            Some("failed") => eval.failed.push(s.clone()),
            _ => {
                if other_cid.contains(&s.as_str()) {
                    eval.cid_mismatch.push(s.clone());
                }
                eval.missing.push(s.clone());
            }
        }
    }
    eval
}

/// The gate sidecar as currently stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateView {
    pub state: String,
    pub release_cid: Option<String>,
}

impl GateView {
    pub fn from_record_value(value: &Value) -> Self {
        Self {
            state: value
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            release_cid: value
                .pointer("/release/cid")
                .and_then(Value::as_str)
                .map(String::from),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Write gate=ready and move the channel pointer.
    Promote,
    /// Nothing is wrong, but required acks are not all in yet.
    Wait { missing: Vec<String> },
    /// Promotion must not happen.
    Refuse(String),
}

fn gate_cid_conflict(gate: Option<&GateView>, release: &StrongRef) -> Option<String> {
    let cid = gate?.release_cid.as_deref()?;
    (cid != release.cid).then(|| {
        format!(
            "gate was issued for release cid {cid} but the release record is now {}; \
             the release was rewritten after publish",
            release.cid
        )
    })
}

/// Decide an ack-driven promotion (`pipeline-promote`, and the auto-promote
/// after `pipeline-ack`). `eval` must be present when the policy is strict.
pub fn decide_promotion(
    policy: &ReleasePolicy,
    gate: Option<&GateView>,
    release: &StrongRef,
    eval: Option<&AckEval>,
) -> Decision {
    if let Some(reason) = gate_cid_conflict(gate, release) {
        return Decision::Refuse(reason);
    }
    if gate.is_some_and(|g| g.state == "failed") {
        return Decision::Refuse(
            "gate is \"failed\"; a failed release is not re-promoted — publish a new version \
             (or override explicitly with `ofw pipeline-skip --override-failed`)"
                .into(),
        );
    }
    if policy.policy == Policy::Strict {
        let Some(eval) = eval else {
            return Decision::Wait {
                missing: policy.stages.clone(),
            };
        };
        if !eval.failed.is_empty() {
            return Decision::Refuse(format!(
                "pipeline stage(s) failed: {}",
                eval.failed.join(", ")
            ));
        }
        if !eval.missing.is_empty() {
            return Decision::Wait {
                missing: eval.missing.clone(),
            };
        }
    }
    Decision::Promote
}

/// Decide a forced promotion (`pipeline-skip`): acks are ignored, but a
/// rewritten release is never promoted and a failed gate needs an explicit
/// override.
pub fn decide_skip(
    gate: Option<&GateView>,
    release: &StrongRef,
    override_failed: bool,
) -> Result<(), String> {
    if let Some(reason) = gate_cid_conflict(gate, release) {
        return Err(reason);
    }
    if gate.is_some_and(|g| g.state == "failed") && !override_failed {
        return Err(
            "gate is \"failed\"; pass --override-failed to force a failed release to ready".into(),
        );
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelMove {
    /// No channel pointer yet.
    Fresh,
    Same,
    Upgrade {
        from: String,
    },
    Downgrade {
        from: String,
    },
    /// One side is not semver, so the order cannot be established.
    Incomparable {
        from: String,
    },
}

/// Classify moving a channel pointer from `current` (the version it names
/// now, if any) to `new`.
pub fn classify_channel_move(current: Option<&str>, new: &str) -> ChannelMove {
    let Some(cur) = current.filter(|c| !c.is_empty()) else {
        return ChannelMove::Fresh;
    };
    if cur == new {
        return ChannelMove::Same;
    }
    let from = cur.to_string();
    match (semver::Version::parse(cur), semver::Version::parse(new)) {
        (Ok(c), Ok(n)) => match n.cmp_precedence(&c) {
            std::cmp::Ordering::Less => ChannelMove::Downgrade { from },
            std::cmp::Ordering::Greater => ChannelMove::Upgrade { from },
            // Equal precedence, different text: build metadata only.
            std::cmp::Ordering::Equal => ChannelMove::Same,
        },
        _ => ChannelMove::Incomparable { from },
    }
}

/// `Err` when the move must be refused without `--allow-downgrade`.
pub fn check_channel_move(
    mv: &ChannelMove,
    new: &str,
    allow_downgrade: bool,
) -> Result<(), String> {
    match mv {
        ChannelMove::Downgrade { from } | ChannelMove::Incomparable { from }
            if !allow_downgrade =>
        {
            let why = if matches!(mv, ChannelMove::Downgrade { .. }) {
                "is older than"
            } else {
                "cannot be ordered against"
            };
            Err(format!(
                "channel currently points at {from}; {new} {why} it. \
                 Pass --allow-downgrade to move the channel anyway"
            ))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ME: &str = "did:plc:publisher";
    const CI: &str = "did:plc:ci";
    const URI: &str = "at://did:plc:publisher/app.openfirmware.firmware.release/cam-1.0.0-stable";

    fn release() -> StrongRef {
        StrongRef {
            uri: URI.into(),
            cid: "bafyrelease".into(),
        }
    }

    fn ack(author: &str, stage: &str, result: &str, at: &str) -> Ack {
        Ack {
            author_did: author.into(),
            release_uri: URI.into(),
            release_cid: Some("bafyrelease".into()),
            stage_key: stage.into(),
            result: result.into(),
            created_at: at.into(),
        }
    }

    fn stages() -> Vec<String> {
        vec!["build".into(), "test".into()]
    }

    fn strict() -> ReleasePolicy {
        ReleasePolicy {
            policy: Policy::Strict,
            stages: stages(),
        }
    }

    fn awaiting() -> GateView {
        GateView {
            state: "awaiting-pipeline".into(),
            release_cid: Some("bafyrelease".into()),
        }
    }

    #[test]
    fn policy_from_record() {
        let p = release_policy(&json!({ "requirePipelineAcks": true }));
        assert_eq!(p.policy, Policy::Strict);
        assert_eq!(p.stages, stages());

        let p = release_policy(&json!({
            "requirePipelineAcks": true, "pipelinePolicy": "strict",
            "requiredPipelineStages": ["lint"]
        }));
        assert_eq!(p.stages, ["lint"]);

        for v in [
            json!({}),
            json!({ "requirePipelineAcks": false }),
            json!({ "requirePipelineAcks": true, "pipelinePolicy": "skipped" }),
        ] {
            let p = release_policy(&v);
            assert_eq!(p.policy, Policy::Skipped, "{v}");
            assert!(p.stages.is_empty());
        }
        assert_eq!(
            release_policy(&json!({ "pipelinePolicy": "optional" })).policy,
            Policy::Optional
        );
        // Unknown strings never weaken the gate.
        assert_eq!(
            release_policy(&json!({ "pipelinePolicy": "whatever" })).policy,
            Policy::Strict
        );
        // An explicit strict policy holds even if the boolean disagrees.
        assert_eq!(
            release_policy(&json!({ "requirePipelineAcks": false, "pipelinePolicy": "strict" }))
                .policy,
            Policy::Strict
        );
    }

    #[test]
    fn all_passed_promotes() {
        let acks = [
            ack(CI, "build", "passed", "2026-01-01T00:00:00Z"),
            ack(CI, "test", "skipped", "2026-01-01T00:01:00Z"),
        ];
        let eval = evaluate_acks(&release(), &stages(), &acks, &[CI.into()]);
        assert!(eval.satisfied());
        assert_eq!(
            decide_promotion(&strict(), Some(&awaiting()), &release(), Some(&eval)),
            Decision::Promote
        );
    }

    #[test]
    fn missing_stage_waits() {
        let acks = [ack(CI, "build", "passed", "2026-01-01T00:00:00Z")];
        let eval = evaluate_acks(&release(), &stages(), &acks, &[CI.into()]);
        assert_eq!(eval.missing, ["test"]);
        assert_eq!(
            decide_promotion(&strict(), Some(&awaiting()), &release(), Some(&eval)),
            Decision::Wait {
                missing: vec!["test".into()]
            }
        );
        // No evaluation at all can never promote a strict release.
        assert!(matches!(
            decide_promotion(&strict(), Some(&awaiting()), &release(), None),
            Decision::Wait { .. }
        ));
    }

    #[test]
    fn acks_from_other_dids_do_not_count() {
        let acks = [
            ack(ME, "build", "passed", "2026-01-01T00:00:00Z"),
            ack("did:plc:mallory", "test", "passed", "2026-01-01T00:00:00Z"),
        ];
        let eval = evaluate_acks(&release(), &stages(), &acks, &[CI.into()]);
        assert_eq!(eval.missing, ["build", "test"]);
    }

    #[test]
    fn ack_for_another_cid_does_not_count() {
        let mut stale = ack(CI, "test", "passed", "2026-01-01T00:02:00Z");
        stale.release_cid = Some("bafyOLD".into());
        let mut unbound = ack(CI, "build", "passed", "2026-01-01T00:02:00Z");
        unbound.release_cid = None;
        let eval = evaluate_acks(&release(), &stages(), &[stale, unbound], &[CI.into()]);
        assert_eq!(eval.missing, ["build", "test"]);
        assert_eq!(eval.cid_mismatch, ["build", "test"]);
    }

    #[test]
    fn ack_for_another_release_uri_does_not_count() {
        let mut other = ack(CI, "build", "passed", "2026-01-01T00:00:00Z");
        other.release_uri = URI.replace("1.0.0", "0.9.0");
        let eval = evaluate_acks(&release(), &stages(), &[other], &[CI.into()]);
        assert_eq!(eval.missing, ["build", "test"]);
        assert!(eval.cid_mismatch.is_empty());
    }

    #[test]
    fn latest_ack_per_stage_wins() {
        let acks = [
            ack(CI, "build", "passed", "2026-01-01T00:00:00Z"),
            ack(CI, "test", "failed", "2026-01-01T00:01:00Z"),
            // Re-run fixed it; listed out of order and with an offset timestamp.
            ack(CI, "test", "passed", "2026-01-01T03:02:00+02:00"),
        ];
        let eval = evaluate_acks(&release(), &stages(), &acks, &[CI.into()]);
        assert!(eval.satisfied(), "{eval:?}");

        let acks = [
            ack(CI, "build", "passed", "2026-01-01T00:00:00Z"),
            ack(CI, "test", "failed", "2026-01-01T00:05:00Z"),
            ack(CI, "test", "passed", "2026-01-01T00:01:00Z"),
            // Garbage timestamps cannot outrank a real one.
            ack(CI, "test", "passed", "zzzz"),
        ];
        let eval = evaluate_acks(&release(), &stages(), &acks, &[CI.into()]);
        assert_eq!(eval.failed, ["test"]);
        assert!(matches!(
            decide_promotion(&strict(), Some(&awaiting()), &release(), Some(&eval)),
            Decision::Refuse(_)
        ));
    }

    #[test]
    fn unknown_result_is_missing() {
        let acks = [
            ack(CI, "build", "passed", "2026-01-01T00:00:00Z"),
            ack(CI, "test", "ok", "2026-01-01T00:00:00Z"),
        ];
        let eval = evaluate_acks(&release(), &stages(), &acks, &[CI.into()]);
        assert_eq!(eval.missing, ["test"]);
    }

    #[test]
    fn failed_gate_is_never_re_promoted_by_acks() {
        let acks = [
            ack(CI, "build", "passed", "2026-01-01T00:00:00Z"),
            ack(CI, "test", "passed", "2026-01-01T00:01:00Z"),
        ];
        let eval = evaluate_acks(&release(), &stages(), &acks, &[CI.into()]);
        let failed = GateView {
            state: "failed".into(),
            release_cid: Some("bafyrelease".into()),
        };
        assert!(matches!(
            decide_promotion(&strict(), Some(&failed), &release(), Some(&eval)),
            Decision::Refuse(_)
        ));
        // Even a release that declares no pipeline cannot leave `failed`.
        let skipped = ReleasePolicy {
            policy: Policy::Skipped,
            stages: vec![],
        };
        assert!(matches!(
            decide_promotion(&skipped, Some(&failed), &release(), None),
            Decision::Refuse(_)
        ));
    }

    #[test]
    fn rewritten_release_is_refused() {
        let gate = GateView {
            state: "awaiting-pipeline".into(),
            release_cid: Some("bafyORIGINAL".into()),
        };
        let skipped = ReleasePolicy {
            policy: Policy::Skipped,
            stages: vec![],
        };
        assert!(matches!(
            decide_promotion(&skipped, Some(&gate), &release(), None),
            Decision::Refuse(_)
        ));
        assert!(decide_skip(Some(&gate), &release(), true).is_err());
    }

    #[test]
    fn non_strict_policies_promote_without_acks() {
        for policy in [Policy::Skipped, Policy::Optional] {
            let p = ReleasePolicy {
                policy,
                stages: vec![],
            };
            assert_eq!(
                decide_promotion(&p, None, &release(), None),
                Decision::Promote
            );
        }
    }

    #[test]
    fn skip_needs_override_for_failed_gate() {
        let failed = GateView {
            state: "failed".into(),
            release_cid: Some("bafyrelease".into()),
        };
        assert!(decide_skip(Some(&failed), &release(), false).is_err());
        assert!(decide_skip(Some(&failed), &release(), true).is_ok());
        assert!(decide_skip(Some(&awaiting()), &release(), false).is_ok());
        assert!(decide_skip(None, &release(), false).is_ok());
    }

    #[test]
    fn decodes_ack_records() {
        let rec = json!({
            "uri": format!("at://{CI}/app.openfirmware.firmware.pipelineAck/3k"),
            "cid": "bafyack",
            "value": {
                "release": { "uri": URI, "cid": "bafyrelease" },
                "stage": "custom", "stageId": "fuzz", "result": "passed",
                "createdAt": "2026-01-01T00:00:00Z", "actor": "did:plc:someone-else",
            }
        });
        let a = ack_from_record(&rec, CI).unwrap();
        assert_eq!(a.author_did, CI);
        assert_eq!(a.stage_key, "custom:fuzz");
        assert_eq!(a.release_cid.as_deref(), Some("bafyrelease"));
        // A record whose URI is not in the repo we listed is dropped.
        assert!(ack_from_record(&rec, ME).is_none());
        // Missing cid is kept (so it can be reported) but never matches.
        let mut no_cid = rec.clone();
        no_cid["value"]["release"] = json!({ "uri": URI });
        assert_eq!(ack_from_record(&no_cid, CI).unwrap().release_cid, None);
        assert!(ack_from_record(&json!({ "uri": "x", "value": {} }), CI).is_none());
        assert_eq!(stage_key("build", Some("x")), "build");
        assert_eq!(stage_key("custom", None), "custom");
    }

    #[test]
    fn channel_moves() {
        use ChannelMove::*;
        assert_eq!(classify_channel_move(None, "1.0.0"), Fresh);
        assert_eq!(classify_channel_move(Some("1.0.0"), "1.0.0"), Same);
        assert_eq!(
            classify_channel_move(Some("1.9.0"), "1.10.0"),
            Upgrade {
                from: "1.9.0".into()
            }
        );
        assert_eq!(
            classify_channel_move(Some("1.10.0"), "1.9.0"),
            Downgrade {
                from: "1.10.0".into()
            }
        );
        // A release is newer than its own pre-release.
        assert!(matches!(
            classify_channel_move(Some("2.0.0"), "2.0.0-rc.1"),
            Downgrade { .. }
        ));
        assert!(matches!(
            classify_channel_move(Some("nightly"), "1.0.0"),
            Incomparable { .. }
        ));

        let down = classify_channel_move(Some("2.0.0"), "1.0.0");
        assert!(check_channel_move(&down, "1.0.0", false).is_err());
        assert!(check_channel_move(&down, "1.0.0", true).is_ok());
        let odd = classify_channel_move(Some("nightly"), "1.0.0");
        assert!(check_channel_move(&odd, "1.0.0", false).is_err());
        assert!(check_channel_move(&Fresh, "1.0.0", false).is_ok());
        assert!(check_channel_move(&Same, "1.0.0", false).is_ok());
        let up = classify_channel_move(Some("1.0.0"), "1.0.1");
        assert!(check_channel_move(&up, "1.0.1", false).is_ok());
    }
}
