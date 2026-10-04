//! A small in-process mock PDS: just enough XRPC for `ofw` end-to-end tests.
#![allow(dead_code)]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};

pub const PUBLISHER_DID: &str = "did:plc:publisher";
pub const PUBLISHER_HANDLE: &str = "publisher.test";
pub const PUBLISHER_PW: &str = "pub-pass";
pub const CI_DID: &str = "did:plc:ci";
pub const CI_HANDLE: &str = "ci.test";
pub const CI_PW: &str = "ci-pass";

pub const RELEASE: &str = "app.openfirmware.firmware.release";
pub const CHANNEL: &str = "app.openfirmware.firmware.channel";
pub const GATE: &str = "app.openfirmware.firmware.gate";
pub const SEAL: &str = "app.openfirmware.firmware.releaseSeal";
pub const ACK: &str = "app.openfirmware.firmware.pipelineAck";
pub const DECLARATION: &str = "app.openfirmware.actor.declaration";

type Key = (String, String, String);

#[derive(Default)]
pub struct State {
    /// (did, collection, rkey) -> record value
    pub records: BTreeMap<Key, Value>,
    pub blobs: HashMap<String, Vec<u8>>,
    /// (nsid, collection): matching requests answer HTTP 500. Empty collection = any.
    pub fail: Vec<(String, String)>,
    /// Every request as "nsid collection".
    pub log: Vec<String>,
    tid: u64,
}

pub fn cid_of(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap();
    format!("bafyrec{}", &hex::encode(Sha256::digest(bytes))[..32])
}

impl State {
    pub fn get(&self, did: &str, collection: &str, rkey: &str) -> Option<&Value> {
        self.records
            .get(&(did.to_string(), collection.to_string(), rkey.to_string()))
    }
    pub fn get_mut(&mut self, did: &str, collection: &str, rkey: &str) -> Option<&mut Value> {
        self.records
            .get_mut(&(did.to_string(), collection.to_string(), rkey.to_string()))
    }
    pub fn remove(&mut self, did: &str, collection: &str, rkey: &str) -> Option<Value> {
        self.records
            .remove(&(did.to_string(), collection.to_string(), rkey.to_string()))
    }
    pub fn list(&self, did: &str, collection: &str) -> Vec<(&String, &Value)> {
        self.records
            .iter()
            .filter(|((d, c, _), _)| d == did && c == collection)
            .map(|((_, _, r), v)| (r, v))
            .collect()
    }
    pub fn count(&self, did: &str, collection: &str) -> usize {
        self.list(did, collection).len()
    }
    pub fn writes(&self) -> usize {
        self.log
            .iter()
            .filter(|l| {
                l.starts_with("com.atproto.repo.createRecord")
                    || l.starts_with("com.atproto.repo.putRecord")
                    || l.starts_with("com.atproto.repo.uploadBlob")
            })
            .count()
    }
}

pub struct MockPds {
    pub url: String,
    pub state: Arc<Mutex<State>>,
}

fn account(identifier: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match identifier {
        PUBLISHER_HANDLE | PUBLISHER_DID => Some((PUBLISHER_DID, PUBLISHER_HANDLE, PUBLISHER_PW)),
        CI_HANDLE | CI_DID => Some((CI_DID, CI_HANDLE, CI_PW)),
        _ => None,
    }
}

fn err(status: u16, error: &str, message: &str) -> (u16, Value) {
    (status, json!({ "error": error, "message": message }))
}

fn uri(did: &str, collection: &str, rkey: &str) -> String {
    format!("at://{did}/{collection}/{rkey}")
}

enum Reply {
    Json(u16, Value),
    Bytes(Vec<u8>),
}

fn handle(
    state: &Mutex<State>,
    method: &str,
    nsid: &str,
    query: &HashMap<String, String>,
    auth: Option<&str>,
    body: &[u8],
) -> Reply {
    let mut st = state.lock().unwrap();
    let json_body: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let q = |k: &str| query.get(k).cloned().unwrap_or_default();
    let collection = if method == "GET" {
        q("collection")
    } else {
        json_body["collection"].as_str().unwrap_or("").to_string()
    };
    st.log.push(format!("{nsid} {collection}"));
    if st
        .fail
        .iter()
        .any(|(n, c)| n == nsid && (c.is_empty() || *c == collection))
    {
        let (s, v) = err(500, "InternalServerError", "injected failure");
        return Reply::Json(s, v);
    }
    let session_did = auth
        .and_then(|a| a.strip_prefix("Bearer access:"))
        .map(String::from);
    let j = |(s, v): (u16, Value)| Reply::Json(s, v);

    match (method, nsid) {
        ("POST", "com.atproto.server.createSession") => {
            let id = json_body["identifier"].as_str().unwrap_or("");
            match account(id) {
                Some((did, handle, pw)) if json_body["password"] == pw => Reply::Json(
                    200,
                    json!({ "did": did, "handle": handle,
                            "accessJwt": format!("access:{did}"),
                            "refreshJwt": format!("refresh:{did}") }),
                ),
                _ => j(err(
                    401,
                    "AuthenticationRequired",
                    "Invalid identifier or password",
                )),
            }
        }
        ("GET", "com.atproto.identity.resolveHandle") => match account(&q("handle")) {
            Some((did, _, _)) => Reply::Json(200, json!({ "did": did })),
            None => j(err(400, "InvalidRequest", "Unable to resolve handle")),
        },
        ("POST", "com.atproto.repo.uploadBlob") => {
            if session_did.is_none() {
                return j(err(401, "AuthenticationRequired", "auth required"));
            }
            let cid = format!("bafkblob{}", &hex::encode(Sha256::digest(body))[..32]);
            st.blobs.insert(cid.clone(), body.to_vec());
            Reply::Json(
                200,
                json!({ "blob": { "$type": "blob", "ref": { "$link": cid },
                                  "mimeType": "application/octet-stream", "size": body.len() } }),
            )
        }
        ("POST", "com.atproto.repo.createRecord") | ("POST", "com.atproto.repo.putRecord") => {
            let Some(did) = session_did else {
                return j(err(401, "AuthenticationRequired", "auth required"));
            };
            if json_body["repo"] != did.as_str() {
                return j(err(403, "InvalidRequest", "cannot write another repo"));
            }
            let record = json_body["record"].clone();
            let rkey = match json_body["rkey"].as_str() {
                Some(r) => r.to_string(),
                None => {
                    st.tid += 1;
                    format!("3tid{:09}", st.tid)
                }
            };
            let key = (did.clone(), collection.clone(), rkey.clone());
            if nsid.ends_with("createRecord") {
                if st.records.contains_key(&key) {
                    return j(err(400, "InvalidRequest", "Record already exists"));
                }
            } else if let Some(swap) = json_body["swapRecord"].as_str() {
                let current = st.records.get(&key).map(cid_of);
                if current.as_deref() != Some(swap) {
                    return j(err(400, "InvalidSwap", "Record was at a different CID"));
                }
            }
            let cid = cid_of(&record);
            st.records.insert(key, record);
            Reply::Json(
                200,
                json!({ "uri": uri(&did, &collection, &rkey), "cid": cid }),
            )
        }
        ("GET", "com.atproto.repo.getRecord") => {
            let (repo, rkey) = (q("repo"), q("rkey"));
            match st.get(&repo, &collection, &rkey) {
                Some(v) => Reply::Json(
                    200,
                    json!({ "uri": uri(&repo, &collection, &rkey), "cid": cid_of(v), "value": v }),
                ),
                None => j(err(
                    400,
                    "RecordNotFound",
                    &format!(
                        "Could not locate record: {}",
                        uri(&repo, &collection, &rkey)
                    ),
                )),
            }
        }
        ("GET", "com.atproto.repo.listRecords") => {
            // Two records per page so the client's cursor handling is exercised.
            let repo = q("repo");
            let cursor = q("cursor");
            let all = st.list(&repo, &collection);
            let page: Vec<_> = all
                .iter()
                .filter(|(r, _)| cursor.is_empty() || r.as_str() > cursor.as_str())
                .take(2)
                .collect();
            let records: Vec<Value> = page
                .iter()
                .map(|(r, v)| json!({ "uri": uri(&repo, &collection, r), "cid": cid_of(v), "value": v }))
                .collect();
            let mut out = json!({ "records": records });
            if page.len() == 2 {
                out["cursor"] = json!(page[1].0);
            }
            Reply::Json(200, out)
        }
        ("GET", "com.atproto.sync.getBlob") => match st.blobs.get(&q("cid")) {
            Some(b) => Reply::Bytes(b.clone()),
            None => j(err(400, "BlobNotFound", "Blob not found")),
        },
        _ => j(err(501, "MethodNotImplemented", nsid)),
    }
}

impl MockPds {
    pub fn start() -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        std::thread::spawn(move || {
            for mut req in server.incoming_requests() {
                let full = format!("http://mock{}", req.url());
                let url = reqwest::Url::parse(&full).unwrap();
                let nsid = url.path().trim_start_matches("/xrpc/").to_string();
                let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
                let auth = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Authorization"))
                    .map(|h| h.value.as_str().to_string());
                let method = req.method().as_str().to_string();
                let mut body = Vec::new();
                req.as_reader().read_to_end(&mut body).unwrap();
                let reply = handle(&shared, &method, &nsid, &query, auth.as_deref(), &body);
                let _ = match reply {
                    Reply::Json(status, v) => req.respond(
                        tiny_http::Response::from_string(v.to_string())
                            .with_status_code(status)
                            .with_header(
                                "Content-Type: application/json"
                                    .parse::<tiny_http::Header>()
                                    .unwrap(),
                            ),
                    ),
                    Reply::Bytes(b) => req.respond(tiny_http::Response::from_data(b)),
                };
            }
        });
        Self {
            url: format!("http://127.0.0.1:{port}"),
            state,
        }
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    pub fn fail(&self, nsid: &str, collection: &str) {
        self.state().fail.push((nsid.into(), collection.into()));
    }

    pub fn heal(&self) {
        self.state().fail.clear();
    }

    /// Run `ofw` as the given account, password via OFW_PASSWORD.
    pub fn ofw_as(&self, who: (&str, &str), args: &[&str]) -> Run {
        let mut cmd = self.command();
        cmd.env("OFW_IDENTIFIER", who.0).env("OFW_PASSWORD", who.1);
        run(cmd.args(args), None)
    }

    pub fn publisher(&self, args: &[&str]) -> Run {
        self.ofw_as((PUBLISHER_HANDLE, PUBLISHER_PW), args)
    }

    pub fn ci(&self, args: &[&str]) -> Run {
        self.ofw_as((CI_HANDLE, CI_PW), args)
    }

    /// Run `ofw` with no credentials in the environment.
    pub fn anonymous(&self, args: &[&str]) -> Run {
        let mut cmd = self.command();
        run(cmd.args(args), None)
    }

    /// A clean `ofw` command: no inherited OFW_* variables, OFW_PDS = this mock.
    pub fn command(&self) -> Command {
        let mut cmd = bare_command();
        cmd.env("OFW_PDS", &self.url);
        cmd
    }
}

pub fn bare_command() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ofw"));
    for (k, _) in std::env::vars() {
        if k.starts_with("OFW_") {
            cmd.env_remove(k);
        }
    }
    cmd
}

pub struct Run {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Run {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.stdout).unwrap_or_else(|e| {
            panic!(
                "stdout is not JSON ({e}): {:?}\n{}",
                self.stdout, self.stderr
            )
        })
    }
    #[track_caller]
    pub fn ok(self) -> Self {
        assert_eq!(
            self.code, 0,
            "expected success\nstdout: {}\nstderr: {}",
            self.stdout, self.stderr
        );
        self
    }
    #[track_caller]
    pub fn fails_with(self, code: i32, needle: &str) -> Self {
        assert_eq!(
            self.code, code,
            "stdout: {}\nstderr: {}",
            self.stdout, self.stderr
        );
        assert!(
            self.stderr.contains(needle) || self.stdout.contains(needle),
            "expected {needle:?} in output\nstdout: {}\nstderr: {}",
            self.stdout,
            self.stderr
        );
        self
    }
    /// Codes of the findings in `ofw audit --json` output.
    pub fn issue_codes(&self) -> Vec<String> {
        self.json()["issues"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["code"].as_str().unwrap().to_string())
            .collect()
    }
}

pub fn run(cmd: &mut Command, stdin: Option<&str>) -> Run {
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn ofw");
    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
    }
    let Output {
        status,
        stdout,
        stderr,
    } = child.wait_with_output().unwrap();
    Run {
        code: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    }
}

/// Write a file under cargo's per-target test temp dir and return its path.
pub fn temp_file(name: &str, contents: &[u8]) -> PathBuf {
    // Tests run as parallel threads: every file gets its own directory.
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir =
        PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("ofw-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, contents).unwrap();
    path
}

pub fn payload(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 7 % 251) as u8).collect()
}

/// RFC 8032 §7.1 TEST 1 key as PKCS#8 PEM, and its raw public key (base64url).
pub const OEM_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g\n\
-----END PRIVATE KEY-----\n";
pub const OEM_PUBLIC: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
