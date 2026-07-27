use crate::atproto::AtpClient;
use crate::chunk::DEFAULT_CHUNK_SIZE;
use crate::publish::{publish, result_json, PublishArgs};
use anyhow::Result;
use clap::Args;
use std::path::PathBuf;

#[derive(Debug, Args)]
pub struct PublishCmd {
    /// Product id (e.g. my-api)
    #[arg(long, env = "OFW_PRODUCT")]
    pub product: String,

    /// Semver version (e.g. 1.0.0)
    #[arg(long, env = "OFW_VERSION")]
    pub version: String,

    /// Channel
    #[arg(long, default_value = "stable", env = "OFW_CHANNEL")]
    pub channel: String,

    /// Artifact kind: firmware | package | container | deployment | bundle
    #[arg(long, default_value = "package", env = "OFW_KIND")]
    pub kind: String,

    /// Path to artifact file
    #[arg(long)]
    pub file: PathBuf,

    /// PDS base URL (required)
    #[arg(long, env = "OFW_PDS")]
    pub pds: String,

    /// Handle or email for createSession
    #[arg(long, env = "OFW_IDENTIFIER")]
    pub identifier: String,

    /// App password
    #[arg(long, env = "OFW_PASSWORD")]
    pub password: String,

    #[arg(long, default_value_t = DEFAULT_CHUNK_SIZE)]
    pub chunk_size: usize,

    #[arg(long, default_value = "application/octet-stream")]
    pub mime_type: String,

    #[arg(long)]
    pub changelog: Option<String>,

    #[arg(long)]
    pub platform: Option<String>,

    #[arg(long, default_value = "sidekar")]
    pub runtime: String,

    /// Skip CI/pipeline gate (default: true — ready right after upload)
    #[arg(long, default_value_t = true, env = "OFW_SKIP_PIPELINE")]
    pub skip_pipeline: bool,

    /// Require CI pipeline (opposite of skip). Sets awaiting_pipeline until acks.
    #[arg(long, default_value_t = false, env = "OFW_REQUIRE_PIPELINE")]
    pub require_pipeline: bool,

    /// Comma-separated stages required when pipeline is enabled (default build,test)
    #[arg(long, env = "OFW_PIPELINE_STAGES")]
    pub stages: Option<String>,

    /// Plan only; do not upload
    #[arg(long)]
    pub dry_run: bool,

    /// Non-interactive (CI)
    #[arg(long, short = 'y')]
    pub yes: bool,

    /// Print machine-readable JSON result
    #[arg(long)]
    pub json: bool,
}

pub fn run(cmd: PublishCmd) -> Result<()> {
    // --require-pipeline wins over default skip
    let skip_pipeline = if cmd.require_pipeline {
        false
    } else {
        cmd.skip_pipeline
    };
    let stages: Vec<String> = cmd
        .stages
        .as_deref()
        .map(|s| {
            s.split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let args = PublishArgs {
        product: cmd.product,
        version: cmd.version,
        channel: cmd.channel,
        kind: cmd.kind,
        file: cmd.file,
        chunk_size: cmd.chunk_size,
        mime_type: cmd.mime_type,
        changelog: cmd.changelog,
        platform: cmd.platform,
        runtime: cmd.runtime,
        dry_run: cmd.dry_run,
        skip_pipeline,
        required_pipeline_stages: stages,
    };

    if !cmd.yes && !cmd.dry_run {
        eprintln!("Tip: pass --yes for CI, or use `ofw release` for guided mode.");
    }

    let client = AtpClient::login(&cmd.pds, &cmd.identifier, &cmd.password)?;
    // When --json, still run full publish but print only JSON on stdout
    // (progress logs go through println in publish — acceptable for now)
    let res = publish(&client, &args)?;
    if cmd.json {
        // Emit a single trailing JSON object line for machine parsers
        println!("---json---");
        println!("{}", serde_json::to_string(&result_json(&res))?);
    }
    Ok(())
}
