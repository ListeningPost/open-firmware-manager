use crate::chunk::DEFAULT_CHUNK_SIZE;
use crate::commands::common::{env_flag, login, LoginArgs, PdsArgs};
use crate::publish::{plan_from_file, publish, result_json, validate_args, PublishArgs};
use crate::sign::load_signing_key;
use crate::validate::parse_stages;
use anyhow::Result;
use clap::Args;
use std::io::IsTerminal;
use std::path::PathBuf;

#[derive(Debug, Args)]
pub struct PublishCmd {
    /// Product id (letters, digits, '.', '_', '-'; e.g. my-api)
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

    #[command(flatten)]
    pub pds: PdsArgs,

    #[command(flatten)]
    pub login: LoginArgs,

    #[arg(long, default_value_t = DEFAULT_CHUNK_SIZE)]
    pub chunk_size: usize,

    #[arg(long, default_value = "application/octet-stream")]
    pub mime_type: String,

    #[arg(long)]
    pub changelog: Option<String>,

    #[arg(long)]
    pub platform: Option<String>,

    /// Apply runtime: iot | sidekar | edge | any
    #[arg(long, default_value = "sidekar")]
    pub runtime: String,

    /// No CI gate: gate=ready and the channel moves right after upload (the default)
    #[arg(long, env = "OFW_SKIP_PIPELINE", action = clap::ArgAction::SetTrue, value_parser = env_flag)]
    pub skip_pipeline: bool,

    /// Require CI acks: gate=awaiting-pipeline until promoted. Wins over --skip-pipeline.
    #[arg(long, env = "OFW_REQUIRE_PIPELINE", action = clap::ArgAction::SetTrue, value_parser = env_flag)]
    pub require_pipeline: bool,

    /// Comma-separated stages required with --require-pipeline (default build,test)
    #[arg(long, env = "OFW_PIPELINE_STAGES")]
    pub stages: Option<String>,

    /// Ed25519 OEM signing key: path to a PKCS#8 PEM file (or, via the
    /// environment variable, the PEM text itself). Adds `oemSignature`.
    #[arg(
        long,
        env = "OFW_OEM_KEY",
        hide_env_values = true,
        value_name = "PEM_FILE"
    )]
    pub oem_key: Option<String>,

    /// Optional key label stored as `oemSignature.keyId`
    #[arg(long, env = "OFW_OEM_KEY_ID")]
    pub oem_key_id: Option<String>,

    /// Let the channel pointer move to an older version than it names now
    #[arg(long)]
    pub allow_downgrade: bool,

    /// Plan only; do not upload
    #[arg(long)]
    pub dry_run: bool,

    /// Do not ask for confirmation (required when stdin is not a terminal)
    #[arg(long, short = 'y')]
    pub yes: bool,

    /// Print machine-readable JSON result
    #[arg(long)]
    pub json: bool,
}

pub fn run(cmd: PublishCmd) -> Result<()> {
    let stages = match cmd.stages.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(raw) => parse_stages(raw)?,
        None => Vec::new(),
    };
    if !stages.is_empty() && !cmd.require_pipeline {
        anyhow::bail!(
            "--stages only applies with --require-pipeline; without it the release would be \
             published as ready with no CI gate"
        );
    }
    if cmd.skip_pipeline && cmd.require_pipeline {
        eprintln!(
            "note: both --skip-pipeline and --require-pipeline are set; requiring the pipeline"
        );
    }
    let oem_key = cmd
        .oem_key
        .as_deref()
        .filter(|k| !k.trim().is_empty())
        .map(load_signing_key)
        .transpose()?;

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
        quiet: cmd.json,
        // --require-pipeline is the stricter choice, so it wins.
        skip_pipeline: !cmd.require_pipeline,
        required_pipeline_stages: stages,
        oem_key,
        oem_key_id: cmd.oem_key_id.filter(|k| !k.is_empty()),
        allow_downgrade: cmd.allow_downgrade,
    };
    // Fail on bad input before asking for or sending any credentials.
    validate_args(&args)?;

    if !cmd.yes && !cmd.dry_run {
        if !(std::io::stdin().is_terminal() && std::io::stderr().is_terminal()) {
            anyhow::bail!(
                "refusing to publish without confirmation: pass --yes (or --dry-run to plan only)"
            );
        }
        let plan = plan_from_file(&args.file, args.chunk_size)?;
        let ok = dialoguer::Confirm::new()
            .with_prompt(format!(
                "Publish {} {} ({} bytes, {} part(s)) to {} on channel {}?",
                args.product,
                args.version,
                plan.image_size,
                plan.chunks.len(),
                cmd.pds.pds,
                args.channel
            ))
            .default(false)
            .interact()?;
        if !ok {
            anyhow::bail!("aborted");
        }
    }

    let mut client = login(&cmd.pds, &cmd.login)?;
    // With --json, stdout carries exactly one JSON object; logs go to stderr.
    let res = publish(&mut client, &args)?;
    if cmd.json {
        println!("{}", serde_json::to_string(&result_json(&res))?);
    }
    Ok(())
}
