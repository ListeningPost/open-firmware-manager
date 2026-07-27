//! Artifact chunking — must match docs/spec-release-chain.md and @open-firmware/core.

use sha2::{Digest, Sha256};

pub const DEFAULT_CHUNK_SIZE: usize = 512 * 1024;

#[derive(Debug, Clone)]
pub struct ChunkPlan {
    pub seq: u32,
    pub byte_offset: u64,
    pub byte_length: u64,
    pub sha256: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ChunkedArtifact {
    pub image_sha256: String,
    pub image_size: u64,
    pub chunks: Vec<ChunkPlan>,
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Split payload into ordered chunks with per-piece and full-image digests.
pub fn chunk_bytes(data: &[u8], chunk_size: usize) -> anyhow::Result<ChunkedArtifact> {
    if chunk_size == 0 {
        anyhow::bail!("chunk_size must be >= 1");
    }
    let image_sha256 = sha256_hex(data);
    let image_size = data.len() as u64;
    let mut chunks = Vec::new();
    if data.is_empty() {
        return Ok(ChunkedArtifact {
            image_sha256,
            image_size,
            chunks,
        });
    }
    let mut offset = 0usize;
    let mut seq = 0u32;
    while offset < data.len() {
        let end = (offset + chunk_size).min(data.len());
        let slice = &data[offset..end];
        chunks.push(ChunkPlan {
            seq,
            byte_offset: offset as u64,
            byte_length: slice.len() as u64,
            sha256: sha256_hex(slice),
            data: slice.to_vec(),
        });
        offset = end;
        seq += 1;
    }
    Ok(ChunkedArtifact {
        image_sha256,
        image_size,
        chunks,
    })
}

pub fn assemble_chunks(
    chunks: &[(u32, &[u8])],
    expected_sha256: Option<&str>,
    expected_size: Option<u64>,
) -> anyhow::Result<Vec<u8>> {
    let mut ordered: Vec<(u32, &[u8])> = chunks.to_vec();
    ordered.sort_by_key(|(s, _)| *s);
    for (i, (seq, _)) in ordered.iter().enumerate() {
        if *seq as usize != i {
            anyhow::bail!("assemble: missing or out-of-order seq at {i}");
        }
    }
    let total: usize = ordered.iter().map(|(_, d)| d.len()).sum();
    if let Some(sz) = expected_size {
        if sz != total as u64 {
            anyhow::bail!("assemble: size mismatch expected {sz} got {total}");
        }
    }
    let mut out = Vec::with_capacity(total);
    for (_, d) in ordered {
        out.extend_from_slice(d);
    }
    if let Some(exp) = expected_sha256 {
        let got = sha256_hex(&out);
        if !got.eq_ignore_ascii_case(exp) {
            anyhow::bail!("assemble: imageSha256 mismatch");
        }
    }
    Ok(out)
}

/// Deterministic release rkey per spec.
pub fn release_rkey(product: &str, version: &str, channel: &str) -> String {
    let raw = format!("{product}-{version}-{channel}");
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 256) as u8).collect();
        let planned = chunk_bytes(&data, 300).unwrap();
        assert_eq!(planned.chunks.len(), 4);
        assert_eq!(planned.image_size, 1000);
        let parts: Vec<(u32, &[u8])> = planned
            .chunks
            .iter()
            .map(|c| (c.seq, c.data.as_slice()))
            .collect();
        let out = assemble_chunks(
            &parts,
            Some(&planned.image_sha256),
            Some(planned.image_size),
        )
        .unwrap();
        assert_eq!(out, data);
    }

    #[test]
    fn rkey_sanitizes() {
        assert_eq!(
            release_rkey("my app", "1.0.0", "stable"),
            "my-app-1.0.0-stable"
        );
    }
}
