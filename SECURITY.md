# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes (pre-1.0; breaking changes possible) |

## Trust model (summary)

- **Artifact authenticity** comes from the publisher's AT Protocol identity (DID) and PDS-signed repository commits, plus content digests on release and chunk records.
- The distribution **server / AppView is not a root of trust** for install. Clients and Sidekar must perform metadata chain audit (Phase A) and payload digest verification (Phase B) against author records before apply.
- **Admin utility** powers are authorization to manage fleet records and server APIs only. They do not replace author signatures on artifacts.
- **IoT client** must not require Docker. **Sidekar** may use Docker on servers; Docker socket access is high privilege and must be locked down.

## Reporting a vulnerability

Please report security issues privately:

1. Email the maintainers listed in the repository (or open a private security advisory on GitHub if enabled).
2. Include: affected component, reproduction steps, impact assessment, and any suggested fix.
3. Allow a reasonable window for a fix before public disclosure.

Do **not** open a public issue for vulnerabilities that could enable remote compromise of fleets, credential theft, or install of malicious firmware.

## Scope of concern

High-priority issues include:

- Bypass of Phase A metadata audit or Phase B digest checks
- Accepting chunk records from a non-author DID
- Install of incomplete / non-`ready` release chains
- Privilege escalation via `adminGrant` or server API
- Credential leakage (app passwords, tokens) in logs or public records

## Hardening notes for operators

- Prefer private AT Protocol networks for sensitive fleets.
- Use scoped app passwords; rotate on device decommission.
- Pin `trustedAuthors` on devices; do not trust arbitrary DIDs from offers alone without policy.
- Monitor admin audit logs for forced / emergency offers.
