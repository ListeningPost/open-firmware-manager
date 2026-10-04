//! Vanilla AT Protocol XRPC client: session refresh, cursors, swap, auth GET.

use anyhow::{Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const COLLECTION_RELEASE: &str = "app.openfirmware.firmware.release";
pub const COLLECTION_CHANNEL: &str = "app.openfirmware.firmware.channel";
pub const COLLECTION_GATE: &str = "app.openfirmware.firmware.gate";
pub const COLLECTION_SEAL: &str = "app.openfirmware.firmware.releaseSeal";
pub const COLLECTION_PIPELINE_ACK: &str = "app.openfirmware.firmware.pipelineAck";
pub const COLLECTION_DECLARATION: &str = "app.openfirmware.actor.declaration";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
struct XrpcErr {
    error: Option<String>,
    message: Option<String>,
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
            .user_agent("ofw-cli/0.1.0")
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
            anyhow::bail!("{}", xrpc_err("createSession", resp));
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
        let token = self
            .session
            .refresh_jwt
            .clone()
            .context("no refreshJwt")?;
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
            anyhow::bail!("{}", xrpc_err("refreshSession", resp));
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
        let mut resp = build(&self.http, self.auth_header()).send()?;
        if resp.status().as_u16() == 401 && self.session.refresh_jwt.is_some() {
            self.refresh()?;
            resp = build(&self.http, self.auth_header()).send()?;
        }
        if !resp.status().is_success() {
            anyhow::bail!("{}", xrpc_err(nsid, resp));
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

    pub fn upload_blob(&mut self, data: &[u8], mime: &str) -> Result<BlobRef> {
        let url = format!("{}/xrpc/com.atproto.repo.uploadBlob", self.session.pds);
        let bytes = data.to_vec();
        let mime = mime.to_string();
        let resp = self.send_authed("uploadBlob", |http, auth| {
            let mut req = http
                .post(&url)
                .header(CONTENT_TYPE, mime.clone())
                .body(bytes.clone());
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
        let url = format!(
            "{}/xrpc/com.atproto.repo.createRecord",
            self.session.pds
        );
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
        let body: CreateRecordResponse = resp.json()?;
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
        let body: CreateRecordResponse = resp.json()?;
        Ok(StrongRef {
            uri: body.uri,
            cid: body.cid,
        })
    }

    pub fn get_record(&self, collection: &str, rkey: &str, repo: Option<&str>) -> Result<Value> {
        let repo = repo
            .map(|s| s.to_string())
            .unwrap_or_else(|| self.session.did.clone());
        let url = format!("{}/xrpc/com.atproto.repo.getRecord", self.session.pds);
        let mut req = self.http.get(&url).query(&[
            ("repo", repo.as_str()),
            ("collection", collection),
            ("rkey", rkey),
        ]);
        if let Some(a) = self.auth_header() {
            req = req.header(AUTHORIZATION, a);
        }
        let resp = req.send().context("getRecord failed")?;
        if !resp.status().is_success() {
            anyhow::bail!("{}", xrpc_err("getRecord", resp));
        }
        Ok(resp.json()?)
    }

    pub fn list_records(&self, collection: &str, repo: &str) -> Result<Vec<Value>> {
        let url = format!("{}/xrpc/com.atproto.repo.listRecords", self.session.pds);
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        let mut last: Option<String> = None;
        for _ in 0..1000 {
            let mut q = vec![
                ("repo", repo.to_string()),
                ("collection", collection.to_string()),
                ("limit", "100".into()),
            ];
            if let Some(c) = &cursor {
                q.push(("cursor", c.clone()));
            }
            let mut req = self.http.get(&url).query(&q);
            if let Some(a) = self.auth_header() {
                req = req.header(AUTHORIZATION, a);
            }
            let resp = req.send()?;
            if !resp.status().is_success() {
                anyhow::bail!("{}", xrpc_err("listRecords", resp));
            }
            let body: Value = resp.json()?;
            if let Some(recs) = body.get("records").and_then(|r| r.as_array()) {
                out.extend(recs.iter().cloned());
            }
            cursor = body
                .get("cursor")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string());
            if cursor.is_none() || cursor == last {
                break;
            }
            last = cursor.clone();
        }
        Ok(out)
    }

    pub fn get_blob(&self, did: &str, cid: &str) -> Result<Vec<u8>> {
        let url = format!("{}/xrpc/com.atproto.sync.getBlob", self.session.pds);
        let mut req = self.http.get(&url).query(&[("did", did), ("cid", cid)]);
        if let Some(a) = self.auth_header() {
            req = req.header(AUTHORIZATION, a);
        }
        let resp = req.send()?;
        if !resp.status().is_success() {
            anyhow::bail!("{}", xrpc_err("getBlob", resp));
        }
        Ok(resp.bytes()?.to_vec())
    }
}

fn xrpc_err(nsid: &str, resp: reqwest::blocking::Response) -> String {
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if let Ok(e) = serde_json::from_str::<XrpcErr>(&body) {
        format!(
            "{nsid} failed: {status} {} {}",
            e.error.unwrap_or_else(|| "Unknown".into()),
            e.message.unwrap_or_default()
        )
    } else {
        format!("{nsid} failed: {status} {body}")
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
