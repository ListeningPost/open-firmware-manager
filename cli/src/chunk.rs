//! Artifact chunking — must match docs/spec-release-chain.md and @open-firmware/core.
//!
//! Planning and upload are streaming: at most one chunk is held in memory.

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom};

pub const DEFAULT_CHUNK_SIZE: usize = 4 * 1024 * 1024;
pub const MAX_BLOB_BYTES: usize = 50 * 1024 * 1024;
/// `parts` maxLength in the release lexicon.
pub const MAX_PARTS: usize = 512;

/// Layout and digest of one part. Bytes are re-read from the file at upload time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkPlan {
    pub seq: u32,
    pub byte_offset: u64,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct ChunkedArtifact {
    pub image_sha256: String,
    pub image_size: u64,
    pub chunks: Vec<ChunkPlan>,
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn validate_chunk_size(chunk_size: usize) -> Result<()> {
    if chunk_size == 0 {
        anyhow::bail!("chunk size must be >= 1");
    }
    if chunk_size > MAX_BLOB_BYTES {
        anyhow::bail!("chunk size {chunk_size} exceeds PDS blob cap {MAX_BLOB_BYTES}");
    }
    Ok(())
}

/// Fill `buf` as far as the reader allows; returns bytes read (short only at EOF).
fn read_full<R: Read>(r: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Stream a payload once, producing ordered part digests and the full-image digest.
pub fn plan_reader<R: Read>(mut reader: R, chunk_size: usize) -> Result<ChunkedArtifact> {
    validate_chunk_size(chunk_size)?;
    let mut image = Sha256::new();
    let mut buf = vec![0u8; chunk_size];
    let mut chunks = Vec::new();
    let mut offset = 0u64;
    loop {
        let n = read_full(&mut reader, &mut buf).context("read artifact")?;
        if n == 0 {
            break;
        }
        if chunks.len() >= MAX_PARTS {
            anyhow::bail!(
                "artifact needs more than {MAX_PARTS} parts at chunk size {chunk_size}; \
                 use a larger --chunk-size"
            );
        }
        let slice = &buf[..n];
        image.update(slice);
        chunks.push(ChunkPlan {
            seq: chunks.len() as u32,
            byte_offset: offset,
            byte_length: n as u64,
            sha256: sha256_hex(slice),
        });
        offset = offset
            .checked_add(n as u64)
            .context("artifact size overflows u64")?;
        if n < chunk_size {
            break;
        }
    }
    Ok(ChunkedArtifact {
        image_sha256: hex::encode(image.finalize()),
        image_size: offset,
        chunks,
    })
}

/// Re-read one planned part and check it still hashes to the planned digest,
/// so a file modified between planning and upload cannot be published.
pub fn read_chunk<R: Read + Seek>(reader: &mut R, plan: &ChunkPlan) -> Result<Vec<u8>> {
    let len = usize::try_from(plan.byte_length).context("part too large for this platform")?;
    reader
        .seek(SeekFrom::Start(plan.byte_offset))
        .with_context(|| format!("seek to part {}", plan.seq))?;
    let mut buf = vec![0u8; len];
    let n = read_full(reader, &mut buf).with_context(|| format!("read part {}", plan.seq))?;
    if n != len {
        anyhow::bail!(
            "artifact changed while publishing: part {} is {n} bytes, planned {len}",
            plan.seq
        );
    }
    if sha256_hex(&buf) != plan.sha256 {
        anyhow::bail!(
            "artifact changed while publishing: part {} digest differs from the plan",
            plan.seq
        );
    }
    Ok(buf)
}

fn sanitize_rkey(raw: String) -> String {
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

/// Deterministic release rkey per spec.
pub fn release_rkey(product: &str, version: &str, channel: &str) -> String {
    sanitize_rkey(format!("{product}-{version}-{channel}"))
}

pub fn channel_rkey(product: &str, channel: &str) -> String {
    sanitize_rkey(format!("{product}-{channel}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn sample(n: u32) -> Vec<u8> {
        (0..n).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn plans_layout_and_digests() {
        let data = sample(1000);
        let planned = plan_reader(&data[..], 300).unwrap();
        assert_eq!(planned.chunks.len(), 4);
        assert_eq!(planned.image_size, 1000);
        assert_eq!(planned.image_sha256, sha256_hex(&data));
        let lens: Vec<u64> = planned.chunks.iter().map(|c| c.byte_length).collect();
        assert_eq!(lens, [300, 300, 300, 100]);
        let offs: Vec<u64> = planned.chunks.iter().map(|c| c.byte_offset).collect();
        assert_eq!(offs, [0, 300, 600, 900]);
        assert_eq!(planned.chunks[3].sha256, sha256_hex(&data[900..]));
    }

    #[test]
    fn exact_multiple_has_no_empty_tail() {
        let data = sample(600);
        let planned = plan_reader(&data[..], 300).unwrap();
        assert_eq!(planned.chunks.len(), 2);
        assert_eq!(planned.image_size, 600);
    }

    #[test]
    fn empty_input_has_no_parts() {
        let planned = plan_reader(&[][..], 16).unwrap();
        assert!(planned.chunks.is_empty());
        assert_eq!(planned.image_size, 0);
        assert_eq!(planned.image_sha256, sha256_hex(b""));
    }

    #[test]
    fn rejects_bad_chunk_sizes_and_too_many_parts() {
        assert!(plan_reader(&[1u8][..], 0).is_err());
        assert!(plan_reader(&[1u8][..], MAX_BLOB_BYTES + 1).is_err());
        let data = vec![0u8; MAX_PARTS + 1];
        assert!(plan_reader(&data[..], 1).is_err());
        assert!(plan_reader(&data[..MAX_PARTS], 1).is_ok());
    }

    #[test]
    fn read_chunk_round_trips_and_detects_change() {
        let data = sample(1000);
        let planned = plan_reader(&data[..], 300).unwrap();
        let mut cur = Cursor::new(data.clone());
        let mut out = Vec::new();
        // Out of order on purpose: read_chunk seeks.
        for c in planned.chunks.iter().rev() {
            let bytes = read_chunk(&mut cur, c).unwrap();
            out.splice(0..0, bytes);
        }
        assert_eq!(out, data);

        let mut tampered = data.clone();
        tampered[650] ^= 0xff;
        let mut cur = Cursor::new(tampered);
        assert!(read_chunk(&mut cur, &planned.chunks[1]).is_ok());
        assert!(read_chunk(&mut cur, &planned.chunks[2]).is_err());

        let mut truncated = Cursor::new(data[..950].to_vec());
        assert!(read_chunk(&mut truncated, &planned.chunks[3]).is_err());
    }

    #[test]
    fn rkey_sanitizes() {
        assert_eq!(
            release_rkey("my app", "1.0.0", "stable"),
            "my-app-1.0.0-stable"
        );
        assert_eq!(channel_rkey("cam", "beta"), "cam-beta");
    }

    #[test]
    fn sha_format() {
        assert!(is_sha256_hex(&"ab".repeat(32)));
        assert!(!is_sha256_hex(&"ab".repeat(31)));
        assert!(!is_sha256_hex(&"zz".repeat(32)));
    }
}
