//! ofw — Open Firmware CLI
//!
//! Publish content-addressed (SHA-256), optionally OEM-signed (Ed25519)
//! release chains to an AT Protocol PDS (the distribution center), from your
//! laptop or GitHub Actions.

mod atproto;
mod audit;
mod chunk;
mod commands;
mod pipeline;
mod publish;
mod sign;
mod validate;

use anyhow::Result;
use clap::{Parser, Subcommand};
use commands::{audit_cmd, pipeline_cmd, publish_cmd, release_cmd};

#[derive(Parser, Debug)]
#[command(
    name = "ofw",
    version,
    about = "Open Firmware: publish releases to an AT Protocol PDS",
    long_about = "The distribution center is your AT Protocol server (PDS).\n\
\n\
Commands:\n  \
  release          Guided wizard\n  \
  publish          Upload artifact (optionally OEM-signed, optionally await CI)\n  \
  pipeline-ack     CI/build/test acknowledgment (CI DID writes its own repo)\n  \
  pipeline-promote Publisher reads CI acks and flips gate+channel\n  \
  pipeline-skip    Force a release ready without CI acks\n  \
  audit            Metadata audit (+ optional blob and OEM signature checks)\n\
\n\
Pipeline: publish --require-pipeline → CI pipeline-ack → pipeline-promote → ready.\n\
Skip:     publish (default) → ready immediately.\n\
\n\
Credentials: set OFW_PASSWORD or use --password-stdin; never put passwords on argv."
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
    /// Audit a release on a PDS; exit code 2 when the release must not be used
    Audit(audit_cmd::AuditCmd),
    /// Post a pipeline/CI acknowledgment (build, test, …)
    #[command(name = "pipeline-ack")]
    PipelineAck(pipeline_cmd::AckArgs),
    /// Force the gate to ready and move the channel, ignoring acks
    #[command(name = "pipeline-skip")]
    PipelineSkip(pipeline_cmd::SkipArgs),
    /// Promote gate+channel once the required acks are present
    #[command(name = "pipeline-promote")]
    PipelinePromote(pipeline_cmd::PromoteArgs),
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Release => release_cmd::run(),
        Commands::Publish(cmd) => publish_cmd::run(cmd),
        Commands::Audit(cmd) => audit_cmd::run(cmd),
        Commands::PipelineAck(a) => pipeline_cmd::run_ack(a),
        Commands::PipelineSkip(s) => pipeline_cmd::run_skip(s),
        Commands::PipelinePromote(p) => pipeline_cmd::run_promote(p),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn cli_definition_is_consistent() {
        Cli::command().debug_assert();
    }
}
