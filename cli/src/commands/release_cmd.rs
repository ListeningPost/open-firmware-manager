//! Guided release wizard.

use crate::atproto::AtpClient;
use crate::chunk::DEFAULT_CHUNK_SIZE;
use crate::commands::common::{check_transport, env_flag, PdsArgs};
use crate::pipeline::DEFAULT_STAGES;
use crate::publish::{plan_from_file, print_plan, publish, PublishArgs};
use crate::sign::load_signing_key;
use crate::validate::{validate_product, validate_version, KINDS};
use anyhow::Result;
use dialoguer::{theme::ColorfulTheme, Confirm, Input, Password, Select};
use std::path::PathBuf;

pub fn run() -> Result<()> {
    let theme = ColorfulTheme::default();
    println!("Open Firmware — guided release");
    println!("Publishes an immutable, content-addressed release to an AT Protocol PDS.");
    println!("(The PDS is the distribution center. Sidekar follows the channel pointer.)\n");

    let pds: String = Input::with_theme(&theme)
        .with_prompt("PDS base URL")
        .default("http://127.0.0.1:2583".into())
        .interact_text()?;
    check_transport(
        &PdsArgs {
            pds: pds.clone(),
            allow_insecure_http: std::env::var("OFW_ALLOW_INSECURE_HTTP")
                .is_ok_and(|v| env_flag(&v) == Ok(true)),
        },
        true,
    )?;
    let identifier: String = Input::with_theme(&theme)
        .with_prompt("Handle or email")
        .interact_text()?;
    let password = Password::with_theme(&theme)
        .with_prompt("App password")
        .interact()?;

    println!("Logging in…");
    let mut client = AtpClient::login(&pds, &identifier, &password)?;
    println!(
        "Logged in as {} ({})",
        client.session.handle, client.session.did
    );

    let product: String = Input::with_theme(&theme)
        .with_prompt("Product id")
        .validate_with(|s: &String| validate_product(s).map_err(|e| e.to_string()))
        .interact_text()?;

    let version: String = Input::with_theme(&theme)
        .with_prompt("Version (semver)")
        .default("1.0.0".into())
        .validate_with(|s: &String| validate_version(s).map(|_| ()).map_err(|e| e.to_string()))
        .interact_text()?;

    let channels = ["stable", "beta", "dev"];
    let channel_idx = Select::with_theme(&theme)
        .with_prompt("Channel")
        .items(&channels)
        .default(0)
        .interact()?;
    let channel = channels[channel_idx].to_string();

    let kind_idx = Select::with_theme(&theme)
        .with_prompt("Artifact kind")
        .items(&KINDS)
        .default(1)
        .interact()?;
    let kind = KINDS[kind_idx].to_string();

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

    let oem_key = match std::env::var("OFW_OEM_KEY").ok().filter(|k| !k.is_empty()) {
        Some(spec) => {
            let key = load_signing_key(&spec)?;
            println!("OEM signing key loaded from OFW_OEM_KEY; the release will be signed.");
            Some(key)
        }
        None => {
            println!("No OFW_OEM_KEY set; the release will not carry an OEM signature.");
            None
        }
    };

    let plan = plan_from_file(&file, chunk_size)?;
    print_plan(&product, &version, &channel, &kind, &plan);

    let dry_run = Confirm::with_theme(&theme)
        .with_prompt("Dry-run only (no upload)?")
        .default(false)
        .interact()?;

    let require_pipeline = Confirm::with_theme(&theme)
        .with_prompt("Require CI/build/test acknowledgments before ready?")
        .default(false)
        .interact()?;

    if !dry_run
        && !Confirm::with_theme(&theme)
            .with_prompt("Upload blobs and write records to the PDS now?")
            .default(true)
            .interact()?
    {
        println!("Aborted.");
        return Ok(());
    }

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
        quiet: false,
        skip_pipeline: !require_pipeline,
        required_pipeline_stages: if require_pipeline {
            DEFAULT_STAGES.iter().map(|s| s.to_string()).collect()
        } else {
            vec![]
        },
        oem_key,
        oem_key_id: std::env::var("OFW_OEM_KEY_ID")
            .ok()
            .filter(|k| !k.is_empty()),
        allow_downgrade: false,
    };

    publish(&mut client, &args)?;
    Ok(())
}
