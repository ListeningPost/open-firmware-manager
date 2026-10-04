//! Phase A metadata integrity suite.

use crate::chunk::is_sha256_hex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseMeta {
    pub version: String,
    pub product: String,
    pub kind: String,
    pub image_sha256: String,
    pub image_size: u64,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditIssue {
    pub code: String,
    pub message: String,
    pub seq: Option<u32>,
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
    let mut issues = Vec::new();
    let required_bytes = release.image_size + opts.staging_overhead_bytes;

    let push = |issues: &mut Vec<AuditIssue>, code: &str, message: String, seq: Option<u32>| {
        issues.push(AuditIssue {
            code: code.to_string(),
            message,
            seq,
        });
    };

    if opts.require_ready && release.status != "ready" {
        push(
            &mut issues,
            "INCOMPLETE_PUBLISH",
            format!(
                "gate state is \"{}\", expected \"ready\"",
                release.status
            ),
            None,
        );
    }

    if !is_sha256_hex(&release.image_sha256) {
        push(
            &mut issues,
            "DIGEST_INVALID",
            "release.imageSha256 is not a 64-char hex SHA-256".into(),
            None,
        );
    }

    if chunks.len() as u32 != release.chunk_count {
        push(
            &mut issues,
            "COUNT_MISMATCH",
            format!(
                "expected {} part(s), got {}",
                release.chunk_count,
                chunks.len()
            ),
            None,
        );
    }

    if let Some(free) = opts.free_space_bytes {
        if required_bytes > free {
            push(
                &mut issues,
                "INSUFFICIENT_SPACE",
                format!("need {required_bytes} bytes, free {free}"),
                None,
            );
        }
    }

    let mut by_seq = std::collections::BTreeMap::new();
    for c in chunks {
        if by_seq.insert(c.seq, c).is_some() {
            push(
                &mut issues,
                "SEQ_DUPLICATE",
                format!("duplicate seq {}", c.seq),
                Some(c.seq),
            );
        }
    }

    let mut ordered: Vec<&ChunkMeta> = Vec::new();
    for seq in 0..release.chunk_count {
        match by_seq.get(&seq) {
            Some(c) => ordered.push(*c),
            None => push(
                &mut issues,
                "SEQ_GAP",
                format!("missing part seq {seq}"),
                Some(seq),
            ),
        }
    }

    let mut expected_offset = 0u64;
    let mut sum_lengths = 0u64;
    for c in &ordered {
        sum_lengths += c.byte_length;
        if c.byte_offset != expected_offset {
            push(
                &mut issues,
                "LAYOUT_INVALID",
                format!(
                    "part seq {} byteOffset {} expected {expected_offset}",
                    c.seq, c.byte_offset
                ),
                Some(c.seq),
            );
        }
        expected_offset += c.byte_length;

        if let Some(did) = &c.author_did {
            if did != &release.author_did {
                push(
                    &mut issues,
                    "AUTHOR_MISMATCH",
                    format!("part seq {} author {did} != {}", c.seq, release.author_did),
                    Some(c.seq),
                );
            }
        }

        if c.sha256.is_empty() {
            push(
                &mut issues,
                "DIGEST_MISSING",
                format!("part seq {} missing sha256", c.seq),
                Some(c.seq),
            );
        } else if !is_sha256_hex(&c.sha256) {
            push(
                &mut issues,
                "DIGEST_INVALID",
                format!("part seq {} invalid sha256", c.seq),
                Some(c.seq),
            );
        }

        if let Some(bs) = c.blob_size {
            if bs != c.byte_length {
                push(
                    &mut issues,
                    "BLOB_SIZE_MISMATCH",
                    format!(
                        "part seq {} blob.size {bs} != byteLength {}",
                        c.seq, c.byte_length
                    ),
                    Some(c.seq),
                );
            }
        }
    }

    if !ordered.is_empty() && sum_lengths != release.image_size {
        push(
            &mut issues,
            "SIZE_MISMATCH",
            format!(
                "sum(byteLength)={sum_lengths} != imageSize={}",
                release.image_size
            ),
            None,
        );
    }

    ChainAuditReport {
        ok: issues.is_empty(),
        issues,
        required_bytes,
        free_space_bytes: opts.free_space_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::chunk_bytes;

    #[test]
    fn good_chain_passes() {
        let data = vec![7u8; 500];
        let planned = chunk_bytes(&data, 200).unwrap();
        let release = ReleaseMeta {
            version: "1.0.0".into(),
            product: "demo".into(),
            kind: "package".into(),
            image_sha256: planned.image_sha256.clone(),
            image_size: planned.image_size,
            chunk_count: planned.chunks.len() as u32,
            channel: "stable".into(),
            status: "ready".into(),
            author_did: "did:plc:author".into(),
            uri: Some("at://did:plc:author/app.openfirmware.firmware.release/r1".into()),
            cid: Some("bafyrelease".into()),
        };
        let chunks: Vec<ChunkMeta> = planned
            .chunks
            .iter()
            .map(|c| ChunkMeta {
                seq: c.seq,
                sha256: c.sha256.clone(),
                byte_offset: c.byte_offset,
                byte_length: c.byte_length,
                blob_cid: Some(format!("bafk{}", c.seq)),
                blob_size: Some(c.byte_length),
                author_did: Some("did:plc:author".into()),
            })
            .collect();
        let report = audit_release_chain(
            &release,
            &chunks,
            &AuditOptions {
                free_space_bytes: Some(10_000),
                ..Default::default()
            },
        );
        assert!(report.ok, "{:?}", report.issues);
    }

    #[test]
    fn publishing_fails_ready_check() {
        let release = ReleaseMeta {
            version: "1.0.0".into(),
            product: "demo".into(),
            kind: "package".into(),
            image_sha256: "a".repeat(64),
            image_size: 0,
            chunk_count: 0,
            channel: "stable".into(),
            status: "awaiting-pipeline".into(),
            author_did: "did:plc:x".into(),
            uri: None,
            cid: None,
        };
        let report = audit_release_chain(&release, &[], &AuditOptions::default());
        assert!(!report.ok);
        assert!(report.issues.iter().any(|i| i.code == "INCOMPLETE_PUBLISH"));
    }
}
