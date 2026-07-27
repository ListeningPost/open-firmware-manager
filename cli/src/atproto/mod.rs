//! Minimal vanilla AT Protocol client (XRPC) for publish path.

use anyhow::{Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const COLLECTION_RELEASE: &str = "app.openfirmware.firmware.release";
pub const COLLECTION_CHUNK: &str = "app.openfirmware.firmware.chunk";
pub const COLLECTION_SEAL: &str = "app.openfirmware.firmware.releaseSeal";
pub const COLLECTION_PIPELINE_ACK: &str = "app.openfirmware.firmware.pipelineAck";

#[derive(Debug, Clone)]
pub struct Session {
    pub pds: String,
    pub did: String,
    pub handle: String,
    pub access_jwt: String,
}

#[derive(Debug, Deserialize)]
struct CreateSessionResponse {
    did: String,
    handle: String,
    #[serde(rename = "accessJwt")]
    access_jwt: String,
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

#[derive(Clone)]
pub struct AtpClient {
    http: Client,
    pub session: Session,
}

impl AtpClient {
    pub fn login(pds: &str, identifier: &str, password: &str) -> Result<Self> {
        let pds = pds.trim_end_matches('/').to_string();
        let http = Client::builder()
            .timeout(Duration::from_secs(120))
            .user_agent("ofw-cli/0.1.0")
            .build()?;

        let url = format!("{pds}/xrpc/com.atproto.server.createSession");
        let resp = http
            .post(&url)
            .json(&json!({
                "identifier": identifier,
                "password": password,
            }))
            .send()
            .context("createSession request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            anyhow::bail!("createSession failed: {status} {body}");
        }

        let body: CreateSessionResponse = resp.json().context("parse createSession")?;
        Ok(Self {
            http,
            session: Session {
                pds,
                did: body.did,
                handle: body.handle,
                access_jwt: body.access_jwt,
            },
        })
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.session.access_jwt)
    }

    pub fn upload_blob(&self, data: &[u8], mime: &str) -> Result<BlobRef> {
        let url = format!("{}/xrpc/com.atproto.repo.uploadBlob", self.session.pds);
        let resp = self
            .http
            .post(&url)
            .header(AUTHORIZATION, self.auth_header())
            .header(CONTENT_TYPE, mime)
            .body(data.to_vec())
            .send()
            .context("uploadBlob request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            anyhow::bail!("uploadBlob failed: {status} {body}");
        }

        let body: UploadBlobResponse = resp.json().context("parse uploadBlob")?;
        let blob: BlobRef = serde_json::from_value(body.blob).context("parse blob ref")?;
        Ok(blob)
    }

    pub fn create_record(
        &self,
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

        let resp = self
            .http
            .post(&url)
            .header(AUTHORIZATION, self.auth_header())
            .json(&payload)
            .send()
            .context("createRecord request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            anyhow::bail!("createRecord {collection} failed: {status} {body}");
        }

        let body: CreateRecordResponse = resp.json()?;
        Ok(StrongRef {
            uri: body.uri,
            cid: body.cid,
        })
    }

    pub fn put_record(&self, collection: &str, rkey: &str, record: Value) -> Result<StrongRef> {
        let url = format!("{}/xrpc/com.atproto.repo.putRecord", self.session.pds);
        let payload = json!({
            "repo": self.session.did,
            "collection": collection,
            "rkey": rkey,
            "record": record,
        });

        let resp = self
            .http
            .post(&url)
            .header(AUTHORIZATION, self.auth_header())
            .json(&payload)
            .send()
            .context("putRecord request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            anyhow::bail!("putRecord {collection}/{rkey} failed: {status} {body}");
        }

        let body: CreateRecordResponse = resp.json()?;
        Ok(StrongRef {
            uri: body.uri,
            cid: body.cid,
        })
    }

    pub fn get_record(&self, collection: &str, rkey: &str, repo: Option<&str>) -> Result<Value> {
        let repo = repo.unwrap_or(&self.session.did);
        let url = format!("{}/xrpc/com.atproto.repo.getRecord", self.session.pds);
        let resp = self
            .http
            .get(&url)
            .query(&[
                ("repo", repo),
                ("collection", collection),
                ("rkey", rkey),
            ])
            .send()
            .context("getRecord failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            anyhow::bail!("getRecord failed: {status} {body}");
        }
        Ok(resp.json()?)
    }

    pub fn list_records(&self, collection: &str, repo: &str, limit: u32) -> Result<Value> {
        let url = format!("{}/xrpc/com.atproto.repo.listRecords", self.session.pds);
        let resp = self
            .http
            .get(&url)
            .query(&[
                ("repo", repo),
                ("collection", collection),
                ("limit", &limit.to_string()),
            ])
            .send()?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            anyhow::bail!("listRecords failed: {status} {body}");
        }
        Ok(resp.json()?)
    }
}
