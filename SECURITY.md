# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes (pre-1.0; breaking changes possible) |

## Trust model (summary)

- **AT Protocol layer:** clients resolve DID → PDS, pin record CIDs, recompute blob CIDs (`CIDv1` raw sha2-256), and refuse authors not in `trustedAuthors` (parsed from `at://`, not stamped from config).
- **OEM layer:** optional detached Ed25519 over `v1|{product}|{version}|{channel}|{imageSha256}|{imageSize}`. Provision `trustedOemKeys` on the device. A PDS operator or leaked app password cannot retarget this signature.
- **AppView / dashboards are not a trust root.** They are an index. Install still runs Phase A (metadata) and Phase B (bytes + CID + digest) against the author repo.
- **Pipeline acks** are a workflow latch, not a second OEM. Independent CI should use a distinct DID listed in `attesterDids`.
- **Admin utility** may create `firmware.offer` jobs that name a release URI. It must **not** push raw firmware bytes. Unsigned `firmware.apply` is rejected.
- **IoT client** must not require Docker. **Sidekar** may use Docker on servers; the Docker socket is root.

## Auth

- CI / `ofw`: app-password `createSession` + `refreshSession`. Treat `OFW_PASSWORD` as the publisher identity.
- Interactive apps: ATProto OAuth with `include:app.openfirmware.authPublisher` (see `docs/oauth-client-metadata.json`).
- Publisher vs consumer skip flags are **different env vars**:
  - `OFW_SKIP_PIPELINE` / `--skip-pipeline` — publisher only
  - `OFW_CONSUMER_SKIP_PIPELINE` — emergency consumer bypass (off by default)

## Control plane

- Admin bearer compared with `timingSafeEqual`; token is not logged unless `OFW_REVEAL_ADMIN_TOKEN=1`.
- Join fingerprint is recomputed as `sha256(product|ed25519PublicKey)`.
- Device auth timestamps must be within `OFW_AUTH_SKEW_MS` (default 5 minutes). Replay of old signatures fails.
- Only **active** enrollments may pull jobs.
- Store writes are serialized and atomically renamed.

## Reporting a vulnerability

Please report security issues privately:

1. Email the maintainers listed in the repository (or open a private security advisory on GitHub if enabled).
2. Include: affected component, reproduction steps, impact assessment, and any suggested fix.
3. Allow a reasonable window for a fix before public disclosure.

Do **not** open a public issue for vulnerabilities that could enable remote compromise of fleets, credential theft, or install of malicious firmware.

## Scope of concern

High-priority issues include:

- Bypass of Phase A metadata audit or Phase B digest/CID checks
- Accepting parts from a DID not in `trustedAuthors`
- Install of non-`ready` gates
- Unsigned firmware apply
- Privilege escalation via `adminGrant` or server API
- Credential leakage (app passwords, tokens) in logs or public records
- OEM signature bypass when `requireOemSignature` is set
