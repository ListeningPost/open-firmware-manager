//! Vanilla AT Protocol XRPC client: session refresh, cursors, swap, auth GET.

use anyhow::{Context, Result};
use bytes::Bytes;
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;
use std::io::Read;
use std::time::Duration;

pub const COLLECTION_RELEASE: &str = "app.openfirmware.firmware.release";
pub const COLLECTION_CHANNEL: &str = "app.openfirmware.firmware.channel";
pub const COLLECTION_GATE: &str = "app.openfirmware.firmware.gate";
pub const COLLECTION_SEAL: &str = "app.openfirmware.firmware.releaseSeal";
pub const COLLECTION_PIPELINE_ACK: &str = "app.openfirmware.firmware.pipelineAck";
pub const COLLECTION_DECLARATION: &str = "app.openfirmware.actor.declaration";

/// A non-2xx XRPC response. Kept as a typed error so callers can tell
/// "record does not exist" apart from auth, network and server failures.
#[derive(Debug, Clone)]
pub struct XrpcError {
    pub nsid: String,
    pub status: u16,
    pub error: Option<String>,
    pub message: String,
}

impl fmt::Display for XrpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} failed: HTTP {} {} {}",
            self.nsid,
            self.status,
            self.error.as_deref().unwrap_or("Unknown"),
            self.message
        )
    }
}

impl std::error::Error for XrpcError {}

impl XrpcError {
    /// True only for the PDS "no such record" answer to getRecord.
    pub fn is_record_not_found(&self) -> bool {
        match self.error.as_deref() {
            Some("RecordNotFound") => true,
            // Older PDS builds answered InvalidRequest with this message.
            Some("InvalidRequest") => self.message.starts_with("Could not locate record"),
            _ => false,
        }
    }
}

/// True if any error in the chain is an XRPC RecordNotFound.
pub fn is_record_not_found(err: &anyhow::Error) -> bool {
    err.chain().any(|e| {
        e.downcast_ref::<XrpcError>()
            .is_some_and(XrpcError::is_record_not_found)
    })
}

#[derive(Debug, Clone)]
pub struct Session {
    pub pds: String,
    pub did: String,
    pub handle: String,
    pub access_jwt: String,
    pub refresh_jwt: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateSessionResponse {
    did: String,
    handle: String,
    #[serde(rename = "accessJwt")]
    access_jwt: String,
    #[serde(rename = "refreshJwt")]
    refresh_jwt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobRef {
    #[serde(rename = "$type", default = "default_blob_type")]
    pub type_: String,
    #[serde(rename = "ref")]
    pub ref_: BlobLink,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub size: u64,
}

fn default_blob_type() -> String {
    "blob".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobLink {
    #[serde(rename = "$link")]
    pub link: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StrongRef {
    pub uri: String,
    pub cid: String,
}

#[derive(Debug, Deserialize)]
struct CreateRecordResponse {
    uri: String,
    cid: String,
}

#[derive(Debug, Deserialize)]
struct UploadBlobResponse {
    blob: Value,
}

#[derive(Debug, Deserialize)]
struct XrpcErrBody {
    error: Option<String>,
    message: Option<String>,
}

/// How the PDS URL will carry credentials and records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transport {
    Https,
    /// Plain http to localhost / 127.0.0.0/8 / ::1 — fine for local stacks.
    LoopbackHttp,
    /// Plain http to a remote host: passwords and tokens travel in cleartext.
    InsecureHttp(String),
}

pub fn classify_pds_url(pds: &str) -> Result<Transport> {
    let url = reqwest::Url::parse(pds).with_context(|| format!("invalid PDS URL {pds:?}"))?;
    let host = url
        .host_str()
        .with_context(|| format!("PDS URL {pds:?} has no host"))?
        .to_string();
    match url.scheme() {
        "https" => Ok(Transport::Https),
        "http" => {
            let bare = host.trim_start_matches('[').trim_end_matches(']');
            let loopback = bare.eq_ignore_ascii_case("localhost")
                || bare
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback());
            if loopback {
                Ok(Transport::LoopbackHttp)
            } else {
                Ok(Transport::InsecureHttp(host))
            }
        }
        other => anyhow::bail!("PDS URL scheme must be https (or http), got {other:?}"),
    }
}

#[derive(Clone)]
pub struct AtpClient {
    http: Client,
    pub session: Session,
}

impl AtpClient {
    fn http() -> Result<Client> {
        Ok(Client::builder()
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("ofw-cli/", env!("CARGO_PKG_VERSION")))
            .build()?)
    }

    pub fn anonymous(pds: &str) -> Result<Self> {
        let pds = pds.trim_end_matches('/').to_string();
        Ok(Self {
            http: Self::http()?,
            session: Session {
                pds,
                did: String::new(),
                handle: String::new(),
                access_jwt: String::new(),
                refresh_jwt: None,
            },
        })
    }

    pub fn login(pds: &str, identifier: &str, password: &str) -> Result<Self> {
        let pds = pds.trim_end_matches('/').to_string();
        let http = Self::http()?;
        let url = format!("{pds}/xrpc/com.atproto.server.createSession");
        let resp = http
            .post(&url)
            .json(&json!({ "identifier": identifier, "password": password }))
            .send()
            .context("createSession request failed")?;
        if !resp.status().is_success() {
            return Err(xrpc_err("createSession", resp).into());
        }
        let body: CreateSessionResponse = resp.json().context("parse createSession")?;
        Ok(Self {
            http,
            session: Session {
                pds,
                did: body.did,
                handle: body.handle,
                access_jwt: body.access_jwt,
                refresh_jwt: body.refresh_jwt,
            },
        })
    }

    fn refresh(&mut self) -> Result<()> {
        let token = self.session.refresh_jwt.clone().context("no refreshJwt")?;
        let url = format!(
            "{}/xrpc/com.atproto.server.refreshSession",
            self.session.pds
        );
        let resp = self
            .http
            .post(&url)
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .send()?;
        if !resp.status().is_success() {
            return Err(xrpc_err("refreshSession", resp).into());
        }
        let body: CreateSessionResponse = resp.json()?;
        self.session.access_jwt = body.access_jwt;
        if body.refresh_jwt.is_some() {
            self.session.refresh_jwt = body.refresh_jwt;
        }
        Ok(())
    }

    fn send_authed(
        &mut self,
        nsid: &str,
        build: impl Fn(&Client, Option<String>) -> reqwest::blocking::RequestBuilder,
    ) -> Result<reqwest::blocking::Response> {
        let mut resp = build(&self.http, self.auth_header())
            .send()
            .with_context(|| format!("{nsid} request failed"))?;
        if resp.status().as_u16() == 401 && self.session.refresh_jwt.is_some() {
            self.refresh()?;
            resp = build(&self.http, self.auth_header())
                .send()
                .with_context(|| format!("{nsid} request failed"))?;
        }
        if !resp.status().is_success() {
            return Err(xrpc_err(nsid, resp).into());
        }
        Ok(resp)
    }

    fn auth_header(&self) -> Option<String> {
        if self.session.access_jwt.is_empty() {
            None
        } else {
            Some(format!("Bearer {}", self.session.access_jwt))
        }
    }

    /// `data` is reference-counted, so a 401 retry does not copy the chunk.
    pub fn upload_blob(&mut self, data: Bytes, mime: &str) -> Result<BlobRef> {
        let url = format!("{}/xrpc/com.atproto.repo.uploadBlob", self.session.pds);
        let resp = self.send_authed("uploadBlob", |http, auth| {
            let mut req = http
                .post(&url)
                .header(CONTENT_TYPE, mime)
                .body(data.clone());
            if let Some(a) = auth {
                req = req.header(AUTHORIZATION, a);
            }
            req
        })?;
        let body: UploadBlobResponse = resp.json().context("parse uploadBlob")?;
        serde_json::from_value(body.blob).context("parse blob ref")
    }

    pub fn create_record(
        &mut self,
        collection: &str,
        record: Value,
        rkey: Option<&str>,
    ) -> Result<StrongRef> {
        let url = format!("{}/xrpc/com.atproto.repo.createRecord", self.session.pds);
        let mut payload = json!({
            "repo": self.session.did,
            "collection": collection,
            "record": record,
        });
        if let Some(k) = rkey {
            payload["rkey"] = json!(k);
        }
        let resp = self.send_authed("createRecord", |http, auth| {
            let mut req = http.post(&url).json(&payload);
            if let Some(a) = auth {
                req = req.header(AUTHORIZATION, a);
            }
            req
        })?;
        let body: CreateRecordResponse = resp.json().context("parse createRecord")?;
        Ok(StrongRef {
            uri: body.uri,
            cid: body.cid,
        })
    }

    pub fn put_record(
        &mut self,
        collection: &str,
        rkey: &str,
        record: Value,
        swap_record: Option<&str>,
    ) -> Result<StrongRef> {
        let url = format!("{}/xrpc/com.atproto.repo.putRecord", self.session.pds);
        let mut payload = json!({
            "repo": self.session.did,
            "collection": collection,
            "rkey": rkey,
            "record": record,
        });
        if let Some(s) = swap_record {
            payload["swapRecord"] = json!(s);
        }
        let resp = self.send_authed("putRecord", |http, auth| {
            let mut req = http.post(&url).json(&payload);
            if let Some(a) = auth {
                req = req.header(AUTHORIZATION, a);
            }
            req
        })?;
        let body: CreateRecordResponse = resp.json().context("parse putRecord")?;
        Ok(StrongRef {
            uri: body.uri,
            cid: body.cid,
        })
    }

    fn get(&mut self, nsid: &str, query: &[(&str, &str)]) -> Result<reqwest::blocking::Response> {
        let url = format!("{}/xrpc/{nsid}", self.session.pds);
        self.send_authed(nsid, |http, auth| {
            let mut req = http.get(&url).query(query);
            if let Some(a) = auth {
                req = req.header(AUTHORIZATION, a);
            }
            req
        })
    }

    /// Fetch a record. A missing record is an `XrpcError` for which
    /// `is_record_not_found` is true; prefer `get_record_opt` when absence is expected.
    pub fn get_record(&mut self, collection: &str, rkey: &str, repo: &str) -> Result<Value> {
        let resp = self.get(
            "com.atproto.repo.getRecord",
            &[("repo", repo), ("collection", collection), ("rkey", rkey)],
        )?;
        resp.json().context("parse getRecord")
    }

    /// `Ok(None)` only when the PDS says the record does not exist. Every other
    /// failure (network, auth, 5xx, malformed body) is an error.
    pub fn get_record_opt(
        &mut self,
        collection: &str,
        rkey: &str,
        repo: &str,
    ) -> Result<Option<Value>> {
        match self.get_record(collection, rkey, repo) {
            Ok(v) => Ok(Some(v)),
            Err(e) if is_record_not_found(&e) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn resolve_handle(&mut self, handle: &str) -> Result<String> {
        let resp = self.get("com.atproto.identity.resolveHandle", &[("handle", handle)])?;
        let body: Value = resp.json().context("parse resolveHandle")?;
        let did = body
            .get("did")
            .and_then(|d| d.as_str())
            .filter(|d| d.starts_with("did:"))
            .with_context(|| format!("resolveHandle({handle}) returned no DID"))?;
        Ok(did.to_string())
    }

    pub fn list_records(&mut self, collection: &str, repo: &str) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..1000 {
            let mut q = vec![("repo", repo), ("collection", collection), ("limit", "100")];
            let cur = cursor.clone();
            if let Some(c) = cur.as_deref() {
                q.push(("cursor", c));
            }
            let resp = self.get("com.atproto.repo.listRecords", &q)?;
            let body: Value = resp.json().context("parse listRecords")?;
            if let Some(recs) = body.get("records").and_then(|r| r.as_array()) {
                out.extend(recs.iter().cloned());
            }
            let next = body
                .get("cursor")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string());
            if next.is_none() || next == cursor {
                return Ok(out);
            }
            cursor = next;
        }
        anyhow::bail!("listRecords {collection} for {repo}: too many pages (cursor never ended)")
    }

    /// Download a blob, refusing to buffer more than `max_bytes`.
    pub fn get_blob(&mut self, did: &str, cid: &str, max_bytes: u64) -> Result<Vec<u8>> {
        let resp = self.get("com.atproto.sync.getBlob", &[("did", did), ("cid", cid)])?;
        let mut out = Vec::new();
        resp.take(max_bytes.saturating_add(1))
            .read_to_end(&mut out)
            .context("read getBlob body")?;
        if out.len() as u64 > max_bytes {
            anyhow::bail!("blob {cid} is larger than the declared {max_bytes} bytes");
        }
        Ok(out)
    }
}

fn xrpc_err(nsid: &str, resp: reqwest::blocking::Response) -> XrpcError {
    let status = resp.status().as_u16();
    let body = resp.text().unwrap_or_default();
    match serde_json::from_str::<XrpcErrBody>(&body) {
        Ok(e) => XrpcError {
            nsid: nsid.to_string(),
            status,
            error: e.error,
            message: e.message.unwrap_or_default(),
        },
        Err(_) => XrpcError {
            nsid: nsid.to_string(),
            status,
            error: None,
            message: body.chars().take(500).collect(),
        },
    }
}

pub fn parse_at_uri(uri: &str) -> Option<(String, String, String)> {
    let rest = uri.strip_prefix("at://")?;
    let mut parts = rest.splitn(3, '/');
    let did = parts.next()?.to_string();
    let collection = parts.next()?.to_string();
    let rkey = parts.next()?.to_string();
    if !did.starts_with("did:") {
        return None;
    }
    Some((did, collection, rkey))
}

/// Split a getRecord response into `(uri, cid, value)`, refusing partial answers.
pub fn record_parts(rec: &Value, what: &str) -> Result<(String, String, Value)> {
    let uri = rec
        .get("uri")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .with_context(|| format!("{what}: getRecord response has no uri"))?;
    let cid = rec
        .get("cid")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .with_context(|| format!("{what}: getRecord response has no cid"))?;
    let value = rec
        .get("value")
        .cloned()
        .with_context(|| format!("{what}: getRecord response has no value"))?;
    Ok((uri.to_string(), cid.to_string(), value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xe(error: Option<&str>, message: &str, status: u16) -> XrpcError {
        XrpcError {
            nsid: "getRecord".into(),
            status,
            error: error.map(String::from),
            message: message.into(),
        }
    }

    #[test]
    fn only_record_not_found_counts_as_missing() {
        assert!(xe(Some("RecordNotFound"), "x", 400).is_record_not_found());
        assert!(xe(
            Some("InvalidRequest"),
            "Could not locate record: at://x",
            400
        )
        .is_record_not_found());
        assert!(!xe(Some("InvalidRequest"), "bad rkey", 400).is_record_not_found());
        assert!(!xe(Some("ExpiredToken"), "", 400).is_record_not_found());
        assert!(!xe(None, "upstream down", 502).is_record_not_found());
    }

    #[test]
    fn not_found_survives_context_wrapping() {
        let e = anyhow::Error::from(xe(Some("RecordNotFound"), "", 400)).context("load gate");
        assert!(is_record_not_found(&e));
        let e = anyhow::Error::from(xe(None, "", 500)).context("load gate");
        assert!(!is_record_not_found(&e));
        assert!(!is_record_not_found(&anyhow::anyhow!("connection refused")));
    }

    #[test]
    fn classifies_transport() {
        assert_eq!(
            classify_pds_url("https://pds.example.com").unwrap(),
            Transport::Https
        );
        for u in [
            "http://127.0.0.1:2583",
            "http://localhost:2583/",
            "http://[::1]:2583",
            "http://127.9.9.9",
        ] {
            assert_eq!(classify_pds_url(u).unwrap(), Transport::LoopbackHttp, "{u}");
        }
        for u in [
            "http://pds:2583",
            "http://pds.example.com",
            "http://10.0.0.5:2583",
            "http://localhost.evil.example",
        ] {
            assert!(
                matches!(classify_pds_url(u).unwrap(), Transport::InsecureHttp(_)),
                "{u}"
            );
        }
        assert!(classify_pds_url("ftp://x").is_err());
        assert!(classify_pds_url("not a url").is_err());
    }

    #[test]
    fn at_uri() {
        assert_eq!(
            parse_at_uri("at://did:plc:a/app.x.y/r1"),
            Some(("did:plc:a".into(), "app.x.y".into(), "r1".into()))
        );
        assert_eq!(parse_at_uri("at://handle.test/app.x.y/r1"), None);
        assert_eq!(parse_at_uri("https://x"), None);
    }

    #[test]
    fn record_parts_requires_uri_cid_value() {
        let ok = json!({"uri": "at://did:plc:a/c/r", "cid": "bafy", "value": {"a": 1}});
        assert!(record_parts(&ok, "release").is_ok());
        assert!(record_parts(&json!({"uri": "at://x", "value": {}}), "release").is_err());
        assert!(record_parts(&json!({"uri": "", "cid": "b", "value": {}}), "release").is_err());
    }
}
