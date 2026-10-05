# Deployment and configuration reference

Open Firmware is an early prototype (0.1.0) and has not been run in production. This page is the operator's reference for the configuration that exists, followed by what you would have to add or accept before relying on it. Read [SECURITY.md](../SECURITY.md) first.

## Roles

| Component | Runs where | Responsibility |
|-----------|------------|----------------|
| PDS | Your infrastructure, or a hosted AT Protocol PDS | Stores release records and blobs |
| `ofw` (or `@open-firmware/host`) | Operator machine or your CI | Publishes releases; promotes them |
| CI attester (optional) | Your CI, with its own account | Records stage results |
| `@open-firmware/sidekar` | Each server host | Polls, verifies, applies |
| `@open-firmware/client` | Embedded in a device or edge application | Same verification, no Docker |
| `apps/server` + `ofw-util` | Private network | Device enrollment and encrypted jobs |

## Recommended settings

1. Serve the PDS over TLS. Use a dedicated publisher account and an app password, supplied to `ofw` through `OFW_PASSWORD` or `--password-stdin`, never on the command line or in the repository.
2. Sign releases with an OEM key (`ofw publish --oem-key`), keep the private key out of CI where possible, and pin the public key on every consumer (`OFW_TRUSTED_OEM_KEYS`). Without this the PDS and the publisher password are the whole trust base.
3. Use a separate attester account for CI and set `OFW_ATTESTER_DIDS` on every Sidekar.
4. Run Sidekar under a supervisor, one per product, with a persistent `WORK_DIR`.
5. Put the control plane behind a TLS-terminating reverse proxy, set `OFW_ADMIN_TOKEN` from a secret store, and pin the control key into devices at the factory.

Publishing from CI: this repository's own workflows (`.github/workflows/ci.yml`, `release.yml`) build, test and package the code; they do not publish Open Firmware releases. To publish your product from GitHub Actions, start from the example at `cli/examples/github-actions-publish.yml`.

## `ofw` CLI

Full reference: [cli/README.md](../cli/README.md). The settings operators most often need:

| Variable / flag | Meaning |
|-----------------|---------|
| `OFW_PDS`, `OFW_IDENTIFIER`, `OFW_PASSWORD` | PDS URL, login handle, app password |
| `--password-stdin` | Read the password from standard input |
| `OFW_ALLOW_INSECURE_HTTP=1` / `--allow-insecure-http` | Permit plain `http://` to a non-loopback host. Off by default. |
| `OFW_OEM_KEY` / `--oem-key` | OEM signing key: a PKCS#8 PEM file path, or (variable only) the PEM text |
| `OFW_OEM_KEY_ID` / `--oem-key-id` | Label stored with the signature |
| `OFW_TRUSTED_OEM_KEYS` / `--trusted-oem-key` | `ofw audit`: pinned OEM public keys |
| `OFW_REQUIRE_PIPELINE=1` / `--require-pipeline`, `OFW_PIPELINE_STAGES` / `--stages` | Publish as `awaiting-pipeline` with these required stages |
| `OFW_AUTHOR_DID` / `--author-did` | `pipeline-ack`: the publisher's DID, when CI is a different account |
| `OFW_ATTESTER_DIDS` / `--attester-did` | `pipeline-promote`, `pipeline-ack`: whose acks count |
| `--allow-downgrade` | Allow a channel pointer to move to an older version |
| `--override-failed` | `pipeline-skip`: force a failed gate to ready |

## Sidekar

The full table, with defaults, is in [sidekar.md](./sidekar.md#configuration). Summary:

| Variable | Default |
|----------|---------|
| `PDS_URL` | `OFW_PDS`, else `http://127.0.0.1:2583` |
| `AUTHOR_DID` / `OFW_AUTHOR_DID` / `AUTHOR_DID_FILE` | required (file default `/config/author.did`) |
| `PRODUCT` | `demo-site` |
| `CHANNEL` | `stable` |
| `POLL_MS` | `5000` |
| `WORK_DIR`, `STATE_FILE` | `/var/lib/sidekar`, `/var/lib/sidekar/state.json` |
| `PACKAGE_TARGET` | `<WORK_DIR>/<product>.bin` |
| `DOCKER_LOAD` | on; `0` disables container releases |
| `COMPOSE_PROJECT_DIR` | unset |
| `HEALTH_PORT` | `9090` |
| `OFW_TRUSTED_OEM_KEYS` | unset (no OEM check) |
| `OFW_REQUIRE_OEM_SIGNATURE` | unset; implied when keys are pinned |
| `OFW_ATTESTER_DIDS` | unset (publisher's own acks count) |
| `OFW_REQUIRED_PIPELINE_STAGES` | unset (use the release's list) |
| `OFW_MAX_IMAGE_BYTES` | 1 GiB |
| `OFW_CONSUMER_SKIP_PIPELINE` | unset; `1` ignores acks |

The defaults for `PDS_URL` and `PRODUCT` exist for the demo stack; set them explicitly.

## Control plane server (`apps/server`)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `8787` | Listen port (plain HTTP) |
| `DATA_FILE` | `/data/control-store.json` | JSON store. Holds the admin token and the job-signing private key; written with mode `0600`. Back it up and protect it. |
| `OFW_ADMIN_TOKEN` | unset | Admin bearer token. When set it always overrides the token in the data file, so changing it rotates the token. When unset, the stored token is used, or a random one is generated on first start. |
| `OFW_REVEAL_ADMIN_TOKEN` | unset | `1` prints the admin token at startup. Otherwise it is never logged. |
| `OFW_CORS_ORIGIN` | unset | Value for `Access-Control-Allow-Origin`. Unset means no cross-origin browser access. `*` is accepted but logs a warning. |
| `OFW_AUTH_SKEW_MS` | `300000` (5 min) | Allowed clock difference for device-signed requests and join requests |
| `OFW_MAX_BODY_BYTES` | `65536` (64 KiB) | Largest request body |
| `OFW_MAX_PENDING_JOINS` | `1000` | Unapproved join requests held at once; further requests get HTTP 429 |
| `OFW_JOIN_TTL_MS` | `86400000` (24 h) | After this a pending join expires and cannot be approved |

Numeric values that are not positive numbers are ignored with a message. At startup the server prints its job-signing public key; this is the value to pin into devices.

`ofw-util` reads `OFW_CONTROL_URL` (default `http://127.0.0.1:8787`) and `OFW_ADMIN_TOKEN`. `ofw-util control-key` prints the server's public key and needs no token.

## Gaps to close before production use

- Consumers do not verify AT Protocol commit signatures or resolve DIDs; pin OEM keys.
- Sidekar and the TypeScript client accept plain-HTTP PDS URLs.
- Sidekar has no rollback, health check or self-update, and no monitoring beyond its log and state file.
- The control plane has no TLS, one shared admin token, a JSON file store for a single process, an in-memory replay cache, and no enrollment revocation or key rotation.
- Device private keys are stored as files.
- No external security review has been done.

## Demo-only material

Everything under `examples/full-stack` (the `pds.test` handles, the fixed publisher password, the generated `pds.secrets.env`, the demo workload) exists to exercise the real protocol path locally and must not be reused elsewhere.
