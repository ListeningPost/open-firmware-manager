//! Connection and credential handling shared by every subcommand.

use crate::atproto::{classify_pds_url, AtpClient, Transport};
use anyhow::{Context, Result};
use clap::Args;
use std::io::{BufRead, IsTerminal};

pub const PASSWORD_ENV: &str = "OFW_PASSWORD";

/// Value parser for boolean flags that can also come from the environment:
/// 1/true/yes/on and 0/false/no/off, and an empty variable counts as unset.
pub fn env_flag(s: &str) -> Result<bool, String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "y" => Ok(true),
        "" | "0" | "false" | "no" | "off" | "n" => Ok(false),
        other => Err(format!("expected true/false/1/0, got {other:?}")),
    }
}

#[derive(Debug, Args)]
pub struct PdsArgs {
    /// PDS base URL (https://…; plain http only for loopback)
    #[arg(long, env = "OFW_PDS")]
    pub pds: String,

    /// Allow plain http to a non-loopback PDS (credentials travel in cleartext)
    #[arg(long, env = "OFW_ALLOW_INSECURE_HTTP", action = clap::ArgAction::SetTrue, value_parser = env_flag)]
    pub allow_insecure_http: bool,
}

#[derive(Debug, Args)]
pub struct LoginArgs {
    /// Handle or email for createSession
    #[arg(long, env = "OFW_IDENTIFIER")]
    pub identifier: Option<String>,

    /// Read the app password from the first line of stdin
    #[arg(long)]
    pub password_stdin: bool,

    /// DEPRECATED, insecure: visible to other users in `ps`. Use the
    /// OFW_PASSWORD environment variable or --password-stdin instead.
    #[arg(long, conflicts_with = "password_stdin", value_name = "PASSWORD")]
    pub password: Option<String>,
}

/// Refuse (or loudly allow) cleartext transport. `with_credentials` is true
/// when a password or session token will be sent.
pub fn check_transport(pds: &PdsArgs, with_credentials: bool) -> Result<()> {
    match classify_pds_url(&pds.pds)? {
        Transport::Https | Transport::LoopbackHttp => Ok(()),
        Transport::InsecureHttp(host) if pds.allow_insecure_http => {
            eprintln!(
                "WARNING: talking to {host} over plain http; credentials and records can be \
                 read or altered in transit."
            );
            Ok(())
        }
        Transport::InsecureHttp(host) if with_credentials => anyhow::bail!(
            "refusing to send credentials to {host} over plain http. Use an https:// PDS URL, \
             or pass --allow-insecure-http (OFW_ALLOW_INSECURE_HTTP=1) for a trusted private network"
        ),
        Transport::InsecureHttp(host) => {
            eprintln!(
                "WARNING: reading from {host} over plain http; the answers are not \
                 authenticated in transit."
            );
            Ok(())
        }
    }
}

/// Where the password comes from, in priority order:
/// `--password-stdin`, `--password` (warned), `OFW_PASSWORD`, interactive prompt.
pub fn resolve_password(login: &LoginArgs) -> Result<String> {
    let pw = if login.password_stdin {
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut line)
            .context("read password from stdin")?;
        line.trim_end_matches(['\r', '\n']).to_string()
    } else if let Some(pw) = &login.password {
        eprintln!(
            "WARNING: --password puts the secret on the command line, where other local \
             users can read it (ps, /proc). Use {PASSWORD_ENV} or --password-stdin."
        );
        pw.clone()
    } else if let Some(pw) = std::env::var(PASSWORD_ENV).ok().filter(|p| !p.is_empty()) {
        pw
    } else if std::io::stdin().is_terminal() && std::io::stderr().is_terminal() {
        dialoguer::Password::new()
            .with_prompt("App password")
            .interact()
            .context("read password")?
    } else {
        anyhow::bail!("no password: set {PASSWORD_ENV} or pass --password-stdin");
    };
    if pw.is_empty() {
        anyhow::bail!("password is empty");
    }
    Ok(pw)
}

/// Log in; every command that writes goes through here.
pub fn login(pds: &PdsArgs, login: &LoginArgs) -> Result<AtpClient> {
    let identifier = login
        .identifier
        .as_deref()
        .filter(|i| !i.is_empty())
        .context("missing --identifier (or OFW_IDENTIFIER)")?;
    check_transport(pds, true)?;
    let password = resolve_password(login)?;
    AtpClient::login(&pds.pds, identifier, &password)
}

/// Log in when an identifier was given, otherwise read anonymously.
pub fn login_or_anonymous(pds: &PdsArgs, args: &LoginArgs) -> Result<AtpClient> {
    if args.identifier.as_deref().is_some_and(|i| !i.is_empty()) {
        login(pds, args)
    } else {
        check_transport(pds, false)?;
        AtpClient::anonymous(&pds.pds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_flags_accept_common_spellings() {
        for t in ["1", "true", "TRUE", "yes", "on"] {
            assert_eq!(env_flag(t), Ok(true), "{t}");
        }
        for f in ["", "0", "false", "No", "off"] {
            assert_eq!(env_flag(f), Ok(false), "{f}");
        }
        assert!(env_flag("maybe").is_err());
    }

    fn pds(url: &str, allow: bool) -> PdsArgs {
        PdsArgs {
            pds: url.into(),
            allow_insecure_http: allow,
        }
    }

    #[test]
    fn cleartext_credentials_need_an_explicit_opt_in() {
        assert!(check_transport(&pds("https://pds.example.com", false), true).is_ok());
        assert!(check_transport(&pds("http://127.0.0.1:2583", false), true).is_ok());
        assert!(check_transport(&pds("http://pds:2583", false), true).is_err());
        assert!(check_transport(&pds("http://pds:2583", true), true).is_ok());
        // Anonymous reads are allowed (with a warning).
        assert!(check_transport(&pds("http://pds:2583", false), false).is_ok());
        assert!(check_transport(&pds("gopher://pds", true), false).is_err());
    }
}
