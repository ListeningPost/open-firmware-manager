//! OEM release signatures (Ed25519), byte-compatible with
//! `packages/core/src/sign/index.ts`.
//!
//! Signed message: `v1|product|version|channel|<lowercase imageSha256>|imageSize`.
//! Record field `oemSignature`: `{ alg: "ed25519", publicKey, sig, keyId? }` with
//! the raw 32-byte public key and 64-byte signature as unpadded base64url.

use anyhow::{Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::pkcs8::DecodePrivateKey;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ALG_ED25519: &str = "ed25519";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OemSignature {
    pub alg: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    pub sig: String,
    #[serde(rename = "keyId", skip_serializing_if = "Option::is_none", default)]
    pub key_id: Option<String>,
}

/// The release fields covered by the OEM signature.
#[derive(Debug, Clone, Copy)]
pub struct SignedFields<'a> {
    pub product: &'a str,
    pub version: &'a str,
    pub channel: &'a str,
    pub image_sha256: &'a str,
    pub image_size: u64,
}

pub fn canonical_release_message(f: &SignedFields<'_>) -> String {
    format!(
        "v1|{}|{}|{}|{}|{}",
        f.product,
        f.version,
        f.channel,
        f.image_sha256.to_lowercase(),
        f.image_size
    )
}

fn b64url_decode(s: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(s.trim().trim_end_matches('='))
        .context("not valid base64url")
}

pub fn public_key_b64url(key: &SigningKey) -> String {
    URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes())
}

/// Load an Ed25519 private key (PKCS#8 PEM, as written by `generateOemKey()` or
/// `openssl genpkey -algorithm ed25519`). `spec` is a file path, or the PEM text
/// itself (convenient for a CI secret in `OFW_OEM_KEY`).
pub fn load_signing_key(spec: &str) -> Result<SigningKey> {
    let pem = if spec.trim_start().starts_with("-----BEGIN") {
        spec.to_string()
    } else {
        std::fs::read_to_string(spec).with_context(|| format!("read OEM key file {spec}"))?
    };
    SigningKey::from_pkcs8_pem(pem.trim())
        .map_err(|e| anyhow::anyhow!("OEM key is not an Ed25519 PKCS#8 PEM private key: {e}"))
}

pub fn sign_release(
    key: &SigningKey,
    fields: &SignedFields<'_>,
    key_id: Option<&str>,
) -> OemSignature {
    let sig = key.sign(canonical_release_message(fields).as_bytes());
    OemSignature {
        alg: ALG_ED25519.into(),
        public_key: public_key_b64url(key),
        sig: URL_SAFE_NO_PAD.encode(sig.to_bytes()),
        key_id: key_id.map(String::from),
    }
}

/// Decode `--trusted-oem-key` values up front so a typo is a usage error,
/// not a silent "untrusted".
pub fn parse_trusted_keys(keys: &[String]) -> Result<Vec<[u8; 32]>> {
    keys.iter()
        .filter(|k| !k.trim().is_empty())
        .map(|k| {
            let raw = b64url_decode(k).with_context(|| format!("trusted OEM key {k:?}"))?;
            <[u8; 32]>::try_from(raw.as_slice())
                .map_err(|_| anyhow::anyhow!("trusted OEM key {k:?} must decode to 32 bytes"))
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OemCheck {
    /// No `oemSignature` on the record.
    Missing,
    /// Signature verifies; `trusted` says whether the key is in the trusted set
    /// (always false when no trusted keys were supplied).
    Valid {
        public_key: String,
        key_id: Option<String>,
        trusted: bool,
    },
    /// Present but malformed, wrong algorithm, or does not verify.
    Invalid(String),
}

/// Verify the `oemSignature` value of a release record against the release fields.
pub fn check_oem_signature(
    signature: Option<&Value>,
    fields: &SignedFields<'_>,
    trusted: &[[u8; 32]],
) -> OemCheck {
    let Some(raw) = signature.filter(|v| !v.is_null()) else {
        return OemCheck::Missing;
    };
    let sig: OemSignature = match serde_json::from_value(raw.clone()) {
        Ok(s) => s,
        Err(e) => return OemCheck::Invalid(format!("malformed oemSignature: {e}")),
    };
    if sig.alg != ALG_ED25519 {
        return OemCheck::Invalid(format!("unsupported alg {}", sig.alg));
    }
    let Ok(pk_raw) = b64url_decode(&sig.public_key) else {
        return OemCheck::Invalid("publicKey is not base64url".into());
    };
    let Ok(pk_bytes) = <[u8; 32]>::try_from(pk_raw.as_slice()) else {
        return OemCheck::Invalid("oem public key must be 32 bytes".into());
    };
    let Ok(key) = VerifyingKey::from_bytes(&pk_bytes) else {
        return OemCheck::Invalid("oem public key is not a valid Ed25519 point".into());
    };
    let Ok(sig_raw) = b64url_decode(&sig.sig) else {
        return OemCheck::Invalid("sig is not base64url".into());
    };
    let Ok(signature) = Signature::from_slice(&sig_raw) else {
        return OemCheck::Invalid("sig must be 64 bytes".into());
    };
    if key
        .verify_strict(canonical_release_message(fields).as_bytes(), &signature)
        .is_err()
    {
        return OemCheck::Invalid("signature mismatch".into());
    }
    OemCheck::Valid {
        public_key: URL_SAFE_NO_PAD.encode(pk_bytes),
        key_id: sig.key_id,
        trusted: trusted.contains(&pk_bytes),
    }
}

#[cfg(test)]
pub(crate) mod test_vectors {
    //! Fixed vector shared with the TypeScript implementation.
    //!
    //! Key: RFC 8032 §7.1 TEST 1 seed, wrapped as PKCS#8. `SIG` was produced by
    //! `signRelease()` from `packages/core/dist/sign/index.js` (Node) for the
    //! fields below, and `verifyOemSignature()` there accepts the signature this
    //! crate produces; `cli/tests/ts_interop.rs` re-runs that check whenever the
    //! TypeScript build is present.
    pub const PRIVATE_KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g\n\
-----END PRIVATE KEY-----\n";
    pub const PUBLIC_KEY: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    pub const PRODUCT: &str = "cam";
    pub const VERSION: &str = "1.2.3";
    pub const CHANNEL: &str = "stable";
    pub const IMAGE_SIZE: u64 = 99;
    pub const KEY_ID: &str = "factory-1";
    pub const MESSAGE: &str =
        "v1|cam|1.2.3|stable|abababababababababababababababababababababababababababababababab|99";
    pub const SIG: &str =
        "up8_IsTc9HBAZIljbb_WYPe0VGd_ulwNUswGwT5IMT3twPHtZoFxWSBJBK7o12NvkA0FlHJ0Rfrj09ydtHGtBw";

    pub fn image_sha256() -> String {
        "ab".repeat(32)
    }
}

#[cfg(test)]
mod tests {
    use super::test_vectors as tv;
    use super::*;
    use serde_json::json;

    fn fields(sha: &str) -> SignedFields<'_> {
        SignedFields {
            product: tv::PRODUCT,
            version: tv::VERSION,
            channel: tv::CHANNEL,
            image_sha256: sha,
            image_size: tv::IMAGE_SIZE,
        }
    }

    #[test]
    fn canonical_message_matches_typescript_form() {
        let sha = tv::image_sha256();
        assert_eq!(canonical_release_message(&fields(&sha)), tv::MESSAGE);
        // TS lowercases the digest before signing.
        let upper = sha.to_uppercase();
        assert_eq!(canonical_release_message(&fields(&upper)), tv::MESSAGE);
    }

    #[test]
    fn signs_the_fixed_vector_exactly_like_typescript() {
        let key = load_signing_key(tv::PRIVATE_KEY_PEM).unwrap();
        assert_eq!(public_key_b64url(&key), tv::PUBLIC_KEY);
        let sha = tv::image_sha256();
        let sig = sign_release(&key, &fields(&sha), Some(tv::KEY_ID));
        assert_eq!(sig.sig, tv::SIG);
        assert_eq!(
            serde_json::to_value(&sig).unwrap(),
            json!({
                "alg": "ed25519",
                "publicKey": tv::PUBLIC_KEY,
                "sig": tv::SIG,
                "keyId": tv::KEY_ID,
            })
        );
        let no_id = sign_release(&key, &fields(&sha), None);
        assert!(serde_json::to_value(&no_id).unwrap().get("keyId").is_none());
    }

    #[test]
    fn verifies_the_typescript_signature() {
        let sha = tv::image_sha256();
        let rec = json!({ "alg": "ed25519", "publicKey": tv::PUBLIC_KEY, "sig": tv::SIG });
        let trusted = parse_trusted_keys(&[tv::PUBLIC_KEY.to_string()]).unwrap();
        assert_eq!(
            check_oem_signature(Some(&rec), &fields(&sha), &trusted),
            OemCheck::Valid {
                public_key: tv::PUBLIC_KEY.into(),
                key_id: None,
                trusted: true
            }
        );
        // Valid signature, but nobody vouches for the key.
        assert!(matches!(
            check_oem_signature(Some(&rec), &fields(&sha), &[]),
            OemCheck::Valid { trusted: false, .. }
        ));
        let other = parse_trusted_keys(&[URL_SAFE_NO_PAD.encode([7u8; 32])]).unwrap();
        assert!(matches!(
            check_oem_signature(Some(&rec), &fields(&sha), &other),
            OemCheck::Valid { trusted: false, .. }
        ));
    }

    #[test]
    fn rejects_retargeted_fields() {
        let rec = json!({ "alg": "ed25519", "publicKey": tv::PUBLIC_KEY, "sig": tv::SIG });
        let sha = tv::image_sha256();
        let other_sha = "cd".repeat(32);
        let cases = [
            SignedFields {
                image_sha256: &other_sha,
                ..fields(&sha)
            },
            SignedFields {
                image_size: 100,
                ..fields(&sha)
            },
            SignedFields {
                version: "1.2.4",
                ..fields(&sha)
            },
            SignedFields {
                channel: "beta",
                ..fields(&sha)
            },
            SignedFields {
                product: "cam2",
                ..fields(&sha)
            },
        ];
        for f in cases {
            assert_eq!(
                check_oem_signature(Some(&rec), &f, &[]),
                OemCheck::Invalid("signature mismatch".into()),
                "{f:?}"
            );
        }
    }

    #[test]
    fn rejects_malformed_signatures() {
        let sha = tv::image_sha256();
        let f = fields(&sha);
        assert_eq!(check_oem_signature(None, &f, &[]), OemCheck::Missing);
        assert_eq!(
            check_oem_signature(Some(&Value::Null), &f, &[]),
            OemCheck::Missing
        );
        let bad = [
            json!("nope"),
            json!({ "alg": "rsa", "publicKey": tv::PUBLIC_KEY, "sig": tv::SIG }),
            json!({ "alg": "ed25519", "publicKey": "AAAA", "sig": tv::SIG }),
            json!({ "alg": "ed25519", "publicKey": "!!!", "sig": tv::SIG }),
            json!({ "alg": "ed25519", "publicKey": tv::PUBLIC_KEY, "sig": "AAAA" }),
            json!({ "alg": "ed25519", "publicKey": tv::PUBLIC_KEY }),
        ];
        for b in bad {
            assert!(
                matches!(check_oem_signature(Some(&b), &f, &[]), OemCheck::Invalid(_)),
                "{b}"
            );
        }
    }

    #[test]
    fn trusted_keys_must_be_32_bytes() {
        assert!(parse_trusted_keys(&["AAAA".into()]).is_err());
        assert!(parse_trusted_keys(&["***".into()]).is_err());
        assert_eq!(parse_trusted_keys(&["".into()]).unwrap().len(), 0);
        // Padded input is tolerated, like the TS decoder.
        let padded = format!("{}=", tv::PUBLIC_KEY);
        assert_eq!(parse_trusted_keys(&[padded]).unwrap().len(), 1);
    }

    #[test]
    fn key_loading_errors_are_clear() {
        assert!(load_signing_key("/nonexistent/oem.pem").is_err());
        let garbage = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
        assert!(load_signing_key(garbage).is_err());
    }
}
