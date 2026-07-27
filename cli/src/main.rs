//! ofw — Open Firmware CLI
//!
//! Publish cryptographically signed release chains to an AT Protocol PDS
//! (the distribution center), from your laptop or GitHub Actions.

mod atproto;
mod audit;
mod chunk;
mod commands;
mod publish;

use anyhow::Result;
use clap::{Parser, Subcommand};
use commands::{audit_cmd, pipeline_cmd, publish_cmd, release_cmd};

#[derive(Parser, Debug)]
#[command(
    name = "ofw",
    version,
    about = "Open Firmware: publish signed releases to an AT Protocol PDS",
    long_about = "The distribution center is your AT Protocol server (PDS).\n\
\n\
Commands:\n  \
  release         Guided wizard\n  \
  publish         Upload artifact (optionally await CI)\n  \
  pipeline-ack    CI/build/test acknowledgment\n  \
  pipeline-skip   Mark release ready without CI\n  \
  audit           Phase A metadata audit\n\
\n\
Pipeline: publish --require-pipeline → pipeline-ack build/test → ready.\n\
Skip:     publish --skip-pipeline (default) → ready immediately."
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Guided release wizard (interactive)
    Release,
    /// Non-interactive publish (GitHub Actions / scripts)
    Publish(publish_cmd::PublishCmd),
    /// Phase A audit of a release on a PDS (no payload download)
    Audit(audit_cmd::AuditCmd),
    /// Post a pipeline/CI acknowledgment (build, test, …)
    #[command(name = "pipeline-ack")]
    PipelineAck(pipeline_cmd::AckArgs),
    /// Skip pipeline gate and mark release ready
    #[command(name = "pipeline-skip")]
    PipelineSkip(pipeline_cmd::SkipArgs),
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Release => release_cmd::run(),
        Commands::Publish(cmd) => publish_cmd::run(cmd),
        Commands::Audit(cmd) => audit_cmd::run(cmd),
        Commands::PipelineAck(a) => {
            pipeline_cmd::run(pipeline_cmd::PipelineCmd::Ack(a))
        }
        Commands::PipelineSkip(s) => {
            pipeline_cmd::run(pipeline_cmd::PipelineCmd::Skip(s))
        }
    }
}
