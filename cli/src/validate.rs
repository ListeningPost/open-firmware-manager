//! Input validation for values that end up in record keys, records and the
//! OEM-signed message.

use anyhow::Result;

pub const KINDS: [&str; 5] = ["firmware", "package", "container", "deployment", "bundle"];
pub const RUNTIMES: [&str; 4] = ["iot", "sidekar", "edge", "any"];
pub const ACK_RESULTS: [&str; 3] = ["passed", "failed", "skipped"];

/// `[A-Za-z0-9][A-Za-z0-9._-]*` — safe as an rkey segment (no lossy
/// sanitizing, so two products cannot collide) and free of the `|` separator
/// used in the signed message.
fn is_token(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn validate_product(product: &str) -> Result<()> {
    if product.is_empty() {
        anyhow::bail!("product must not be empty");
    }
    if product.len() > 128 {
        anyhow::bail!("product must be at most 128 characters");
    }
    if !is_token(product) {
        anyhow::bail!(
            "product {product:?} must start with a letter or digit and contain only \
             letters, digits, '.', '_' or '-'"
        );
    }
    Ok(())
}

pub fn validate_version(version: &str) -> Result<semver::Version> {
    if version.len() > 64 {
        anyhow::bail!("version must be at most 64 characters");
    }
    semver::Version::parse(version)
        .map_err(|e| anyhow::anyhow!("version {version:?} is not valid semver (e.g. 1.2.3): {e}"))
}

pub fn validate_channel(channel: &str) -> Result<()> {
    if channel.is_empty() || channel.len() > 32 || !is_token(channel) {
        anyhow::bail!(
            "channel {channel:?} must be 1-32 characters of letters, digits, '.', '_' or '-' \
             (usually stable, beta or dev)"
        );
    }
    Ok(())
}

pub fn validate_kind(kind: &str) -> Result<()> {
    if !KINDS.contains(&kind) {
        anyhow::bail!("kind {kind:?} must be one of: {}", KINDS.join(", "));
    }
    Ok(())
}

pub fn validate_runtime(runtime: &str) -> Result<()> {
    if !RUNTIMES.contains(&runtime) {
        anyhow::bail!(
            "runtime {runtime:?} must be one of: {}",
            RUNTIMES.join(", ")
        );
    }
    Ok(())
}

/// A pipeline stage name as stored in `requiredPipelineStages` / acks.
pub fn validate_stage(stage: &str) -> Result<()> {
    if stage.is_empty() || stage.len() > 64 {
        anyhow::bail!("stage name must be 1-64 characters, got {stage:?}");
    }
    if !stage
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
    {
        anyhow::bail!("stage {stage:?} may only contain letters, digits, '.', '_', '-' or ':'");
    }
    Ok(())
}

pub fn validate_ack_result(result: &str) -> Result<()> {
    if !ACK_RESULTS.contains(&result) {
        anyhow::bail!("--result must be passed|failed|skipped, got {result:?}");
    }
    Ok(())
}

/// Parse `--stages build,test` into validated, de-duplicated names.
pub fn parse_stages(raw: &str) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for s in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        validate_stage(s)?;
        if !out.iter().any(|x| x == s) {
            out.push(s.to_string());
        }
    }
    if out.is_empty() {
        anyhow::bail!("--stages must name at least one stage");
    }
    if out.len() > 32 {
        anyhow::bail!("--stages allows at most 32 stages");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product() {
        for ok in ["cam", "my-app", "my_app.v2", "9lives"] {
            assert!(validate_product(ok).is_ok(), "{ok}");
        }
        let long = "a".repeat(129);
        for bad in [
            "",
            " ",
            "my app",
            "a|b",
            "a/b",
            "-lead",
            ".lead",
            "caf\u{e9}",
            &long,
        ] {
            assert!(validate_product(bad).is_err(), "{bad:?}");
        }
        assert!(validate_product(&"a".repeat(128)).is_ok());
    }

    #[test]
    fn version() {
        for ok in ["1.0.0", "0.1.0-rc.1", "1.1759000000.0", "2.0.0+build.5"] {
            assert!(validate_version(ok).is_ok(), "{ok}");
        }
        for bad in [
            "", "1", "1.0", "v1.0.0", "1.0.0|x", "latest", "01.0.0", "1.0.0 ",
        ] {
            assert!(validate_version(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn channel_kind_runtime() {
        assert!(validate_channel("stable").is_ok());
        assert!(validate_channel("").is_err());
        assert!(validate_channel("a b").is_err());
        assert!(validate_channel("a|b").is_err());
        for k in KINDS {
            assert!(validate_kind(k).is_ok());
        }
        assert!(validate_kind("Package").is_err());
        assert!(validate_kind("").is_err());
        assert!(validate_runtime("sidekar").is_ok());
        assert!(validate_runtime("vm").is_err());
    }

    #[test]
    fn stages() {
        assert_eq!(
            parse_stages(" build, test ,build").unwrap(),
            vec!["build".to_string(), "test".to_string()]
        );
        assert_eq!(parse_stages("custom:fuzz").unwrap(), ["custom:fuzz"]);
        assert!(parse_stages("").is_err());
        assert!(parse_stages(" , ").is_err());
        assert!(parse_stages("build,te st").is_err());
        assert!(validate_stage(&"s".repeat(65)).is_err());
    }

    #[test]
    fn ack_result() {
        assert!(validate_ack_result("passed").is_ok());
        assert!(validate_ack_result("ok").is_err());
    }
}
