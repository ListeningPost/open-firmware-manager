//! Phase A metadata integrity suite, plus the Phase B blob probe.
//!
//! Everything here is pure (no network) and treats record contents as untrusted:
//! arithmetic is checked and malformed fields become findings, never panics.

use crate::chunk::is_sha256_hex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Cap on per-kind repeated findings so a hostile record cannot make the
/// report itself unbounded.
const MAX_GAP_FINDINGS: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseMeta {
    pub version: String,
    pub product: String,
    pub kind: String,
    pub image_sha256: String,
    pub image_size: u64,
    /// Number of parts the release is *declared* to have (seal `partCount`,
    /// or derived from `imageSize`/`chunkSize`), not merely `parts.len()`.
    pub chunk_count: u32,
    pub channel: String,
    pub status: String,
    pub author_did: String,
    pub uri: Option<String>,
    pub cid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkMeta {
    pub seq: u32,
    pub sha256: String,
    pub byte_offset: u64,
    pub byte_length: u64,
    pub blob_cid: Option<String>,
    pub blob_size: Option<u64>,
    pub author_did: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditIssue {
    pub code: String,
    pub message: String,
    pub seq: Option<u32>,
}

impl AuditIssue {
    pub fn new(code: &str, message: impl Into<String>, seq: Option<u32>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            seq,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainAuditReport {
    pub ok: bool,
    pub issues: Vec<AuditIssue>,
    pub required_bytes: u64,
    pub free_space_bytes: Option<u64>,
}

pub struct AuditOptions {
    pub free_space_bytes: Option<u64>,
    pub staging_overhead_bytes: u64,
    pub require_ready: bool,
}

impl Default for AuditOptions {
    fn default() -> Self {
        Self {
            free_space_bytes: None,
            staging_overhead_bytes: 0,
            require_ready: true,
        }
    }
}

pub fn audit_release_chain(
    release: &ReleaseMeta,
    chunks: &[ChunkMeta],
    opts: &AuditOptions,
) -> ChainAuditReport {
    let mut issues: Vec<AuditIssue> = Vec::new();

    let required_bytes = match release.image_size.checked_add(opts.staging_overhead_bytes) {
        Some(n) => n,
        None => {
            issues.push(AuditIssue::new(
                "IMAGE_TOO_LARGE",
                format!(
                    "imageSize {} plus staging overhead {} overflows u64",
                    release.image_size, opts.staging_overhead_bytes
                ),
                None,
            ));
            u64::MAX
        }
    };

    if opts.require_ready && release.status != "ready" {
        issues.push(AuditIssue::new(
            "INCOMPLETE_PUBLISH",
            format!("gate state is \"{}\", expected \"ready\"", release.status),
            None,
        ));
    }

    if !is_sha256_hex(&release.image_sha256) {
        issues.push(AuditIssue::new(
            "DIGEST_INVALID",
            "release.imageSha256 is not a 64-char hex SHA-256",
            None,
        ));
    }

    if chunks.is_empty() {
        issues.push(AuditIssue::new("EMPTY_CHAIN", "release has no parts", None));
    }

    if chunks.len() as u64 != u64::from(release.chunk_count) {
        issues.push(AuditIssue::new(
            "COUNT_MISMATCH",
            format!(
                "expected {} part(s), got {}",
                release.chunk_count,
                chunks.len()
            ),
            None,
        ));
    }

    if let Some(free) = opts.free_space_bytes {
        if required_bytes > free {
            issues.push(AuditIssue::new(
                "INSUFFICIENT_SPACE",
                format!("need {required_bytes} bytes, free {free}"),
                None,
            ));
        }
    }

    let mut by_seq = std::collections::BTreeMap::new();
    for c in chunks {
        if by_seq.insert(c.seq, c).is_some() {
            issues.push(AuditIssue::new(
                "SEQ_DUPLICATE",
                format!("duplicate seq {}", c.seq),
                Some(c.seq),
            ));
        }
    }

    // Walk the declared range 0..chunk_count, but never loop on an
    // attacker-chosen count: stop reporting once the gap budget is spent.
    let mut ordered: Vec<&ChunkMeta> = Vec::new();
    let mut gaps = 0usize;
    for seq in 0..release.chunk_count {
        match by_seq.get(&seq) {
            Some(c) => ordered.push(*c),
            None => {
                gaps += 1;
                if gaps > MAX_GAP_FINDINGS {
                    issues.push(AuditIssue::new(
                        "SEQ_GAP",
                        format!("more parts missing from seq {seq} onward (not listed)"),
                        Some(seq),
                    ));
                    break;
                }
                issues.push(AuditIssue::new(
                    "SEQ_GAP",
                    format!("missing part seq {seq}"),
                    Some(seq),
                ));
            }
        }
    }
    // Parts whose seq lies outside the declared range are never "ordered";
    // COUNT_MISMATCH / SEQ_GAP above already fail the audit for them.

    // `sum` is both the running sum(byteLength) and the expected next offset.
    let mut sum: Option<u64> = Some(0);
    for c in &ordered {
        match sum {
            Some(expected_offset) => {
                if c.byte_offset != expected_offset {
                    issues.push(AuditIssue::new(
                        "LAYOUT_INVALID",
                        format!(
                            "part seq {} byteOffset {} expected {expected_offset}",
                            c.seq, c.byte_offset
                        ),
                        Some(c.seq),
                    ));
                }
                sum = expected_offset.checked_add(c.byte_length);
                if sum.is_none() {
                    issues.push(AuditIssue::new(
                        "LAYOUT_INVALID",
                        format!(
                            "sum(byteLength) overflows u64 at part seq {} (byteLength {})",
                            c.seq, c.byte_length
                        ),
                        Some(c.seq),
                    ));
                }
            }
            None => { /* overflow already reported; offsets are meaningless now */ }
        }

        if let Some(did) = &c.author_did {
            if did != &release.author_did {
                issues.push(AuditIssue::new(
                    "AUTHOR_MISMATCH",
                    format!("part seq {} author {did} != {}", c.seq, release.author_did),
                    Some(c.seq),
                ));
            }
        }

        if c.sha256.is_empty() {
            issues.push(AuditIssue::new(
                "DIGEST_MISSING",
                format!("part seq {} missing sha256", c.seq),
                Some(c.seq),
            ));
        } else if !is_sha256_hex(&c.sha256) {
            issues.push(AuditIssue::new(
                "DIGEST_INVALID",
                format!("part seq {} invalid sha256", c.seq),
                Some(c.seq),
            ));
        }

        if let Some(bs) = c.blob_size {
            if bs != c.byte_length {
                issues.push(AuditIssue::new(
                    "BLOB_SIZE_MISMATCH",
                    format!(
                        "part seq {} blob.size {bs} != byteLength {}",
                        c.seq, c.byte_length
                    ),
                    Some(c.seq),
                ));
            }
        }
    }

    if let Some(total) = sum {
        if !ordered.is_empty() && total != release.image_size {
            issues.push(AuditIssue::new(
                "SIZE_MISMATCH",
                format!(
                    "sum(byteLength)={total} != imageSize={}",
                    release.image_size
                ),
                None,
            ));
        }
    }

    ChainAuditReport {
        ok: issues.is_empty(),
        issues,
        required_bytes,
        free_space_bytes: opts.free_space_bytes,
    }
}

/// A release record decoded strictly: anything missing or mistyped is a finding.
#[derive(Debug, Clone)]
pub struct ParsedRelease {
    pub version: String,
    pub product: String,
    pub kind: String,
    pub channel: String,
    pub image_sha256: String,
    pub image_size: u64,
    pub chunk_size: Option<u64>,
    pub chunks: Vec<ChunkMeta>,
    pub oem_signature: Option<Value>,
    pub issues: Vec<AuditIssue>,
}

impl ParsedRelease {
    /// Part count implied by `imageSize` and `chunkSize`, when the record
    /// declares a chunk size.
    pub fn count_from_chunk_size(&self) -> Option<u64> {
        let cs = self.chunk_size.filter(|c| *c > 0)?;
        Some(self.image_size.div_ceil(cs))
    }
}

fn req_str(value: &Value, field: &str, issues: &mut Vec<AuditIssue>) -> String {
    match value.get(field).and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            issues.push(AuditIssue::new(
                "TYPE_MISMATCH",
                format!("release.{field} is missing or not a non-empty string"),
                None,
            ));
            String::new()
        }
    }
}

/// Decode the `value` of a release record. `part_author` is the DID of the
/// repo the parts (blobs) are served from.
pub fn parse_release_record(value: &Value, part_author: &str) -> ParsedRelease {
    let mut issues = Vec::new();

    if let Some(t) = value.get("$type").and_then(|t| t.as_str()) {
        if t != crate::atproto::COLLECTION_RELEASE {
            issues.push(AuditIssue::new(
                "TYPE_MISMATCH",
                format!("record $type is {t}, not a firmware release"),
                None,
            ));
        }
    }

    let version = req_str(value, "version", &mut issues);
    let product = req_str(value, "product", &mut issues);
    let kind = req_str(value, "kind", &mut issues);
    let image_sha256 = value
        .get("imageSha256")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let channel = value
        .get("channel")
        .and_then(|v| v.as_str())
        .unwrap_or("stable")
        .to_string();

    let image_size = match value.get("imageSize").and_then(|v| v.as_u64()) {
        Some(n) => n,
        None => {
            issues.push(AuditIssue::new(
                "TYPE_MISMATCH",
                "release.imageSize is missing or not a non-negative integer",
                None,
            ));
            0
        }
    };

    let chunk_size = match value.get("chunkSize") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_u64().filter(|n| *n > 0) {
            Some(n) => Some(n),
            None => {
                issues.push(AuditIssue::new(
                    "TYPE_MISMATCH",
                    "release.chunkSize is not a positive integer",
                    None,
                ));
                None
            }
        },
    };

    let mut chunks = Vec::new();
    match value.get("parts").and_then(|p| p.as_array()) {
        None => issues.push(AuditIssue::new(
            "TYPE_MISMATCH",
            "release.parts is missing or not an array",
            None,
        )),
        Some(parts) => {
            for (i, p) in parts.iter().enumerate() {
                let seq = p
                    .get("seq")
                    .and_then(|x| x.as_u64())
                    .and_then(|n| u32::try_from(n).ok());
                let byte_offset = p.get("byteOffset").and_then(|x| x.as_u64());
                let byte_length = p.get("byteLength").and_then(|x| x.as_u64());
                let (Some(seq), Some(byte_offset), Some(byte_length)) =
                    (seq, byte_offset, byte_length)
                else {
                    issues.push(AuditIssue::new(
                        "TYPE_MISMATCH",
                        format!(
                            "parts[{i}]: seq, byteOffset and byteLength must be non-negative \
                             integers in range"
                        ),
                        seq,
                    ));
                    continue;
                };
                chunks.push(ChunkMeta {
                    seq,
                    sha256: p
                        .get("sha256")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    byte_offset,
                    byte_length,
                    blob_cid: p
                        .pointer("/blob/ref/$link")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string()),
                    blob_size: p.pointer("/blob/size").and_then(|x| x.as_u64()),
                    author_did: Some(part_author.to_string()),
                });
            }
        }
    }

    ParsedRelease {
        version,
        product,
        kind,
        channel,
        image_sha256,
        image_size,
        chunk_size,
        chunks,
        oem_signature: value.get("oemSignature").filter(|v| !v.is_null()).cloned(),
        issues,
    }
}

/// Phase B probe: fetch every part in seq order, check each part's size and
/// digest, then check the digest and size of the assembled image. Parts are
/// hashed as they stream past; the image is never held in memory.
pub fn verify_parts<F>(release: &ReleaseMeta, chunks: &[ChunkMeta], mut fetch: F) -> Vec<AuditIssue>
where
    F: FnMut(&ChunkMeta) -> anyhow::Result<Vec<u8>>,
{
    let mut issues = Vec::new();
    let mut ordered: Vec<&ChunkMeta> = chunks.iter().collect();
    ordered.sort_by_key(|c| c.seq);

    let mut image = Sha256::new();
    let mut total: Option<u64> = Some(0);
    let mut complete = true;

    for c in ordered {
        let bytes = match fetch(c) {
            Ok(b) => b,
            Err(e) => {
                complete = false;
                issues.push(AuditIssue::new(
                    "BLOB_UNAVAILABLE",
                    format!("part {}: {e:#}", c.seq),
                    Some(c.seq),
                ));
                continue;
            }
        };
        if bytes.len() as u64 != c.byte_length {
            issues.push(AuditIssue::new(
                "BLOB_SIZE_MISMATCH",
                format!(
                    "part {} is {} bytes, record says {}",
                    c.seq,
                    bytes.len(),
                    c.byte_length
                ),
                Some(c.seq),
            ));
        }
        let got = hex::encode(Sha256::digest(&bytes));
        if !got.eq_ignore_ascii_case(&c.sha256) {
            issues.push(AuditIssue::new(
                "DIGEST_INVALID",
                format!("part {} sha256 mismatch", c.seq),
                Some(c.seq),
            ));
        }
        image.update(&bytes);
        total = total.and_then(|t| t.checked_add(bytes.len() as u64));
    }

    if complete {
        match total {
            Some(t) if t == release.image_size => {}
            Some(t) => issues.push(AuditIssue::new(
                "SIZE_MISMATCH",
                format!(
                    "assembled image is {t} bytes, imageSize says {}",
                    release.image_size
                ),
                None,
            )),
            None => issues.push(AuditIssue::new(
                "SIZE_MISMATCH",
                "assembled image size overflows u64",
                None,
            )),
        }
        let got = hex::encode(image.finalize());
        if !got.eq_ignore_ascii_case(&release.image_sha256) {
            issues.push(AuditIssue::new(
                "DIGEST_INVALID",
                format!(
                    "assembled image sha256 {got} does not match release.imageSha256 {}",
                    release.image_sha256
                ),
                None,
            ));
        }
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::{plan_reader, sha256_hex};
    use serde_json::json;

    const AUTHOR: &str = "did:plc:author";

    fn fixture(data: &[u8], chunk: usize) -> (ReleaseMeta, Vec<ChunkMeta>) {
        let planned = plan_reader(data, chunk).unwrap();
        let release = ReleaseMeta {
            version: "1.0.0".into(),
            product: "demo".into(),
            kind: "package".into(),
            image_sha256: planned.image_sha256.clone(),
            image_size: planned.image_size,
            chunk_count: planned.chunks.len() as u32,
            channel: "stable".into(),
            status: "ready".into(),
            author_did: AUTHOR.into(),
            uri: Some(format!(
                "at://{AUTHOR}/app.openfirmware.firmware.release/r1"
            )),
            cid: Some("bafyrelease".into()),
        };
        let chunks = planned
            .chunks
            .iter()
            .map(|c| ChunkMeta {
                seq: c.seq,
                sha256: c.sha256.clone(),
                byte_offset: c.byte_offset,
                byte_length: c.byte_length,
                blob_cid: Some(format!("bafk{}", c.seq)),
                blob_size: Some(c.byte_length),
                author_did: Some(AUTHOR.into()),
            })
            .collect();
        (release, chunks)
    }

    fn codes(report: &ChainAuditReport) -> Vec<&str> {
        report.issues.iter().map(|i| i.code.as_str()).collect()
    }

    fn audit(release: &ReleaseMeta, chunks: &[ChunkMeta]) -> ChainAuditReport {
        audit_release_chain(release, chunks, &AuditOptions::default())
    }

    #[test]
    fn good_chain_passes() {
        let (release, chunks) = fixture(&[7u8; 500], 200);
        let report = audit_release_chain(
            &release,
            &chunks,
            &AuditOptions {
                free_space_bytes: Some(10_000),
                ..Default::default()
            },
        );
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.required_bytes, 500);
    }

    #[test]
    fn non_ready_gate_fails() {
        for status in ["awaiting-pipeline", "failed", "missing", ""] {
            let (mut release, chunks) = fixture(&[7u8; 500], 200);
            release.status = status.into();
            let report = audit(&release, &chunks);
            assert!(!report.ok);
            assert_eq!(codes(&report), ["INCOMPLETE_PUBLISH"], "{status}");
        }
    }

    #[test]
    fn empty_chain_fails() {
        let (mut release, _) = fixture(&[7u8; 500], 200);
        release.chunk_count = 0;
        release.image_size = 0;
        let report = audit(&release, &[]);
        assert!(codes(&report).contains(&"EMPTY_CHAIN"));
    }

    #[test]
    fn count_mismatch_when_a_part_is_dropped() {
        // Declared 3 parts; the record lists only the first two.
        let (release, mut chunks) = fixture(&[7u8; 500], 200);
        chunks.pop();
        let report = audit(&release, &chunks);
        assert!(!report.ok);
        let c = codes(&report);
        assert!(c.contains(&"COUNT_MISMATCH"), "{c:?}");
        assert!(c.contains(&"SEQ_GAP"), "{c:?}");
    }

    #[test]
    fn count_mismatch_when_an_extra_part_is_appended() {
        let (release, mut chunks) = fixture(&[7u8; 500], 200);
        chunks.push(ChunkMeta {
            seq: 3,
            sha256: "a".repeat(64),
            byte_offset: 500,
            byte_length: 10,
            blob_cid: None,
            blob_size: None,
            author_did: Some(AUTHOR.into()),
        });
        let report = audit(&release, &chunks);
        assert!(codes(&report).contains(&"COUNT_MISMATCH"));
    }

    #[test]
    fn huge_declared_count_is_bounded() {
        let (mut release, chunks) = fixture(&[7u8; 500], 200);
        release.chunk_count = u32::MAX;
        let report = audit(&release, &chunks);
        assert!(!report.ok);
        let gaps = report.issues.iter().filter(|i| i.code == "SEQ_GAP").count();
        assert_eq!(gaps, MAX_GAP_FINDINGS + 1);
    }

    #[test]
    fn author_mismatch() {
        let (release, mut chunks) = fixture(&[7u8; 500], 200);
        chunks[1].author_did = Some("did:plc:mallory".into());
        let report = audit(&release, &chunks);
        assert_eq!(codes(&report), ["AUTHOR_MISMATCH"]);
        assert_eq!(report.issues[0].seq, Some(1));
    }

    #[test]
    fn byte_length_sum_overflow_is_a_finding_not_a_panic() {
        let (mut release, mut chunks) = fixture(&[7u8; 500], 200);
        chunks[1].byte_length = u64::MAX;
        chunks[1].blob_size = Some(u64::MAX);
        release.image_size = 99;
        let report = audit(&release, &chunks);
        assert!(!report.ok);
        assert!(
            report
                .issues
                .iter()
                .any(|i| i.code == "LAYOUT_INVALID" && i.message.contains("overflows")),
            "{:?}",
            report.issues
        );
    }

    #[test]
    fn image_size_plus_overhead_overflow_is_a_finding() {
        let (mut release, chunks) = fixture(&[7u8; 500], 200);
        release.image_size = u64::MAX;
        let report = audit_release_chain(
            &release,
            &chunks,
            &AuditOptions {
                staging_overhead_bytes: 1,
                free_space_bytes: Some(1 << 40),
                ..Default::default()
            },
        );
        let c = codes(&report);
        assert!(c.contains(&"IMAGE_TOO_LARGE"), "{c:?}");
        assert!(c.contains(&"INSUFFICIENT_SPACE"), "{c:?}");
        assert_eq!(report.required_bytes, u64::MAX);
    }

    #[test]
    fn insufficient_space() {
        let (release, chunks) = fixture(&[7u8; 500], 200);
        let report = audit_release_chain(
            &release,
            &chunks,
            &AuditOptions {
                free_space_bytes: Some(499),
                ..Default::default()
            },
        );
        assert_eq!(codes(&report), ["INSUFFICIENT_SPACE"]);
    }

    #[test]
    fn layout_size_digest_and_duplicates() {
        let (release, mut chunks) = fixture(&[7u8; 500], 200);
        chunks[1].byte_offset = 201;
        assert_eq!(codes(&audit(&release, &chunks)), ["LAYOUT_INVALID"]);

        let (mut release, chunks) = fixture(&[7u8; 500], 200);
        release.image_size = 501;
        assert_eq!(codes(&audit(&release, &chunks)), ["SIZE_MISMATCH"]);

        let (mut release, chunks) = fixture(&[7u8; 500], 200);
        release.image_sha256 = "xyz".into();
        assert_eq!(codes(&audit(&release, &chunks)), ["DIGEST_INVALID"]);

        let (release, mut chunks) = fixture(&[7u8; 500], 200);
        chunks[0].sha256 = String::new();
        chunks[2].sha256 = "nothex".into();
        assert_eq!(
            codes(&audit(&release, &chunks)),
            ["DIGEST_MISSING", "DIGEST_INVALID"]
        );

        let (release, mut chunks) = fixture(&[7u8; 500], 200);
        chunks[2].seq = 1;
        let c = audit(&release, &chunks);
        assert!(codes(&c).contains(&"SEQ_DUPLICATE"));
        assert!(codes(&c).contains(&"SEQ_GAP"));

        let (release, mut chunks) = fixture(&[7u8; 500], 200);
        chunks[0].blob_size = Some(1);
        assert_eq!(codes(&audit(&release, &chunks)), ["BLOB_SIZE_MISMATCH"]);
    }

    fn record(data: &[u8], chunk: usize) -> Value {
        let planned = plan_reader(data, chunk).unwrap();
        let parts: Vec<Value> = planned
            .chunks
            .iter()
            .map(|c| {
                json!({
                    "seq": c.seq,
                    "sha256": c.sha256,
                    "byteOffset": c.byte_offset,
                    "byteLength": c.byte_length,
                    "blob": { "$type": "blob", "ref": { "$link": format!("bafk{}", c.seq) },
                              "mimeType": "application/octet-stream", "size": c.byte_length },
                })
            })
            .collect();
        json!({
            "$type": "app.openfirmware.firmware.release",
            "version": "1.0.0", "product": "demo", "kind": "package",
            "imageSha256": planned.image_sha256, "imageSize": planned.image_size,
            "chunkSize": chunk, "channel": "beta", "parts": parts,
        })
    }

    #[test]
    fn parses_a_well_formed_record() {
        let p = parse_release_record(&record(&[1u8; 500], 200), AUTHOR);
        assert!(p.issues.is_empty(), "{:?}", p.issues);
        assert_eq!(p.chunks.len(), 3);
        assert_eq!(p.channel, "beta");
        assert_eq!(p.count_from_chunk_size(), Some(3));
        assert_eq!(p.chunks[2].blob_cid.as_deref(), Some("bafk2"));
        assert_eq!(p.chunks[2].blob_size, Some(100));
        assert_eq!(p.chunks[0].author_did.as_deref(), Some(AUTHOR));
        assert!(p.oem_signature.is_none());
    }

    #[test]
    fn declared_count_from_chunk_size_exposes_truncated_parts() {
        // Attacker drops the last part and shrinks nothing else: parts.len()==2,
        // but imageSize/chunkSize still declare 3.
        let mut rec = record(&[1u8; 500], 200);
        rec["parts"].as_array_mut().unwrap().pop();
        let p = parse_release_record(&rec, AUTHOR);
        assert_eq!(p.chunks.len(), 2);
        assert_eq!(p.count_from_chunk_size(), Some(3));
    }

    #[test]
    fn mistyped_fields_are_findings() {
        let mut rec = record(&[1u8; 500], 200);
        rec["imageSize"] = json!(-5);
        rec["version"] = json!(7);
        rec["chunkSize"] = json!(0);
        rec["parts"][0]["seq"] = json!(4_294_967_296u64); // does not fit u32
        rec["parts"][1]["byteLength"] = json!(-1);
        rec["parts"][2]["byteOffset"] = json!("400");
        let p = parse_release_record(&rec, AUTHOR);
        assert_eq!(p.chunks.len(), 0);
        assert_eq!(
            p.issues
                .iter()
                .filter(|i| i.code == "TYPE_MISMATCH")
                .count(),
            6,
            "{:?}",
            p.issues
        );
        assert_eq!(p.count_from_chunk_size(), None);

        let p = parse_release_record(&json!({ "$type": "app.bsky.feed.post" }), AUTHOR);
        assert!(p.issues.iter().any(|i| i.message.contains("$type")));
        assert!(p.issues.iter().any(|i| i.message.contains("parts")));
    }

    #[test]
    fn probe_accepts_matching_blobs() {
        let data: Vec<u8> = (0..500u32).map(|i| i as u8).collect();
        let (release, chunks) = fixture(&data, 200);
        let issues = verify_parts(&release, &chunks, |c| {
            let s = c.byte_offset as usize;
            Ok(data[s..s + c.byte_length as usize].to_vec())
        });
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn probe_flags_a_corrupt_part() {
        let data: Vec<u8> = (0..500u32).map(|i| i as u8).collect();
        let (release, chunks) = fixture(&data, 200);
        let issues = verify_parts(&release, &chunks, |c| {
            let s = c.byte_offset as usize;
            let mut b = data[s..s + c.byte_length as usize].to_vec();
            if c.seq == 1 {
                b[0] ^= 1;
            }
            Ok(b)
        });
        let part: Vec<_> = issues.iter().filter(|i| i.seq == Some(1)).collect();
        assert_eq!(part.len(), 1);
        assert_eq!(part[0].code, "DIGEST_INVALID");
        // ...and the assembled image is wrong too.
        assert!(issues
            .iter()
            .any(|i| i.seq.is_none() && i.code == "DIGEST_INVALID"));
    }

    #[test]
    fn probe_flags_bad_whole_image_digest_even_when_every_part_is_consistent() {
        // Each part matches its own sha256, but the release-level digest names a
        // different image: per-part checks alone would pass this.
        let data: Vec<u8> = (0..500u32).map(|i| i as u8).collect();
        let (mut release, chunks) = fixture(&data, 200);
        release.image_sha256 = sha256_hex(b"some other image");
        let issues = verify_parts(&release, &chunks, |c| {
            let s = c.byte_offset as usize;
            Ok(data[s..s + c.byte_length as usize].to_vec())
        });
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(issues[0].code, "DIGEST_INVALID");
        assert!(issues[0].message.contains("assembled image"));
    }

    #[test]
    fn probe_flags_unavailable_and_wrong_sized_blobs() {
        let data: Vec<u8> = (0..500u32).map(|i| i as u8).collect();
        let (release, chunks) = fixture(&data, 200);
        let issues = verify_parts(&release, &chunks, |c| {
            if c.seq == 0 {
                anyhow::bail!("getBlob failed: HTTP 404")
            }
            Ok(vec![0u8; 3])
        });
        let c: Vec<&str> = issues.iter().map(|i| i.code.as_str()).collect();
        assert!(c.contains(&"BLOB_UNAVAILABLE"));
        assert!(c.contains(&"BLOB_SIZE_MISMATCH"));
        // No whole-image verdict when a part could not be fetched.
        assert!(!issues.iter().any(|i| i.message.contains("assembled")));
    }
}
