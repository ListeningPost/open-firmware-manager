//! Guided release wizard — production PDS only.

use crate::atproto::AtpClient;
use crate::chunk::DEFAULT_CHUNK_SIZE;
use crate::publish::{plan_from_file, print_plan, publish, PublishArgs};
use anyhow::Result;
use dialoguer::{theme::ColorfulTheme, Confirm, Input, Password, Select};
use std::path::PathBuf;

pub fn run() -> Result<()> {
    let theme = ColorfulTheme::default();
    println!("Open Firmware — guided release");
    println!("Publishes a cryptographically signed release chain to an AT Protocol PDS.");
    println!("(The PDS is the distribution center. Sidekar pulls when status=ready.)\n");

    let pds: String = Input::with_theme(&theme)
        .with_prompt("PDS base URL")
        .default("http://127.0.0.1:2583".into())
        .interact_text()?;
    let identifier: String = Input::with_theme(&theme)
        .with_prompt("Handle or email")
        .interact_text()?;
    let password = Password::with_theme(&theme)
        .with_prompt("App password")
        .interact()?;

    println!("Logging in…");
    let client = AtpClient::login(&pds, &identifier, &password)?;
    println!("Logged in as {} ({})", client.session.handle, client.session.did);

    let product: String = Input::with_theme(&theme)
        .with_prompt("Product id")
        .interact_text()?;

    let version: String = Input::with_theme(&theme)
        .with_prompt("Version (semver)")
        .default("1.0.0".into())
        .interact_text()?;

    let channel_idx = Select::with_theme(&theme)
        .with_prompt("Channel")
        .items(&["stable", "beta", "dev"])
        .default(0)
        .interact()?;
    let channel = ["stable", "beta", "dev"][channel_idx].to_string();

    let kind_idx = Select::with_theme(&theme)
        .with_prompt("Artifact kind")
        .items(&["package", "container", "firmware", "deployment", "bundle"])
        .default(0)
        .interact()?;
    let kind = ["package", "container", "firmware", "deployment", "bundle"][kind_idx].to_string();

    let path: String = Input::with_theme(&theme)
        .with_prompt("Path to artifact file")
        .interact_text()?;
    let file = PathBuf::from(&path);

    let chunk_size: usize = Input::with_theme(&theme)
        .with_prompt("Chunk size (bytes)")
        .default(DEFAULT_CHUNK_SIZE)
        .interact_text()?;

    let runtime = if kind == "firmware" {
        "iot".to_string()
    } else {
        "sidekar".to_string()
    };

    let plan = plan_from_file(&file, chunk_size)?;
    print_plan(&product, &version, &channel, &kind, &plan);

    let dry_run = Confirm::with_theme(&theme)
        .with_prompt("Dry-run only (no upload)?")
        .default(false)
        .interact()?;

    if !dry_run
        && !Confirm::with_theme(&theme)
            .with_prompt("Upload blobs and write signed records to the PDS now?")
            .default(true)
            .interact()?
    {
        println!("Aborted.");
        return Ok(());
    }

    let require_pipeline = Confirm::with_theme(&theme)
        .with_prompt("Require CI/build/test acknowledgments before ready?")
        .default(false)
        .interact()?;

    let args = PublishArgs {
        product,
        version,
        channel,
        kind,
        file,
        chunk_size,
        mime_type: "application/octet-stream".into(),
        changelog: None,
        platform: None,
        runtime,
        dry_run,
        skip_pipeline: !require_pipeline,
        required_pipeline_stages: if require_pipeline {
            vec!["build".into(), "test".into()]
        } else {
            vec![]
        },
    };

    publish(&client, &args)?;
    Ok(())
}
