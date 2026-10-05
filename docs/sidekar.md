# Sidekar

Sidekar (`@open-firmware/sidekar`) is the host-side update agent: a small Node process that follows one product and channel on a PDS, verifies each new release, and applies it. The name is a play on "sidecar": it runs alongside the services it keeps current.

It is intended for always-on machines such as edge servers, NAS boxes and home servers. Devices that cannot run Docker or Node use the `@open-firmware/client` library directly.

## What it does today

Every `POLL_MS` it:

1. reads its state file to find the version it last applied;
2. asks the client library for the release the channel points at, which performs every check in [spec-release-chain.md](./spec-release-chain.md#consumer-rules): trusted author, product/channel binding, CID pin, gate, attester acks, OEM signature, per-part and whole-image digests;
3. skips the release unless its version is strictly newer than the applied one;
4. runs the apply handler for the release's `kind`;
5. on success, records the version, URI, CID and digest in the state file.

A release that fails a check is refused and the reason is logged; a failed handler is logged too. Either way Sidekar tries again on the next poll, and the state file is only updated after a successful apply. It stops cleanly on SIGTERM or SIGINT, and serves a trivial health response on `HEALTH_PORT`.

## Apply handlers

| Kind | What happens | Status |
|------|--------------|--------|
| `package` | The verified file is copied to `PACKAGE_TARGET` (default `<WORK_DIR>/<product>.bin`). | Working |
| `container` | `docker load -i <file>`; then, if `COMPOSE_PROJECT_DIR` is set, `docker compose up -d --remove-orphans` in that directory. | Working. Sidekar does not create, tag or restart individual containers itself; the compose project must reference the loaded image. |
| `firmware` | The verified file is written to `<WORK_DIR>/<product>-firmware.bin` for an external flashing tool. | Staging only |
| `deployment` | With `COMPOSE_PROJECT_DIR`: the file is copied there as `bundle.bin` and `docker compose up -d` is run. The archive is not unpacked. Otherwise handled like `package`. | Placeholder |
| `bundle` | Handled exactly like `package`. No ordered steps. | Placeholder |

An unrecognised kind is refused. Library users can replace any handler with `setApplyHandler(kind, fn)`, and inject a different command runner.

## Not implemented

- Creating or updating containers directly, reconciling running containers against a desired state
- Unpacking and applying a compose or deployment archive; multi-step bundles
- Health checks after apply, and rollback
- Updating Sidekar itself through the channel
- More than one product per process (run one Sidekar per product)
- Enforcing service windows or fleet policy records
- Refusing a non-TLS `PDS_URL`

## Configuration

Environment variables read by the `sidekar` executable (`packages/sidekar/src/cli.ts`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `PDS_URL` | `OFW_PDS`, else `http://127.0.0.1:2583` | PDS base URL |
| `AUTHOR_DID` | `OFW_AUTHOR_DID`, else the contents of `AUTHOR_DID_FILE` | Publisher DID. Required. It is the only trusted author. |
| `AUTHOR_DID_FILE` | `/config/author.did` | File to read the DID from when the variable is unset |
| `PRODUCT` | `demo-site` | Product to follow |
| `CHANNEL` | `stable` | Channel to follow |
| `POLL_MS` | `5000` | Poll interval in milliseconds. (The library default, when embedding `Sidekar` directly, is 15000.) |
| `WORK_DIR` | `/var/lib/sidekar` | Downloads and default targets |
| `STATE_FILE` | `/var/lib/sidekar/state.json` | Applied-version state |
| `PACKAGE_TARGET` | `<WORK_DIR>/<product>.bin` | Destination for `package` payloads (`MESSAGE_FILE` is accepted as an alias) |
| `DOCKER_LOAD` | on | Set to `0` to refuse `container` releases. Any other value, or unset, leaves it on. |
| `COMPOSE_PROJECT_DIR` | unset | Compose project to bring up after a load |
| `HEALTH_PORT` | `9090` | Port for the health response |
| `OFW_TRUSTED_OEM_KEYS` | unset | Comma-separated pinned OEM public keys (base64url). When set, every release must carry a valid signature from one of them. |
| `OFW_REQUIRE_OEM_SIGNATURE` | unset | `1` requires an OEM signature. With no pinned keys this refuses every release. It cannot be used to switch the requirement off while keys are pinned. |
| `OFW_ATTESTER_DIDS` | unset | Comma-separated CI attester DIDs. When set, their passing acks are required for every release. |
| `OFW_REQUIRED_PIPELINE_STAGES` | unset | Comma-separated stages to require, replacing the list in the release record |
| `OFW_MAX_IMAGE_BYTES` | 1 GiB (`0` or unset) | Largest image Sidekar will accept |
| `OFW_CONSUMER_SKIP_PIPELINE` | unset | `1` ignores pipeline acks. Emergency use only. The gate must still be `ready`, and the OEM and digest checks still apply. |

A deployment that takes the trust model seriously sets at least `OFW_TRUSTED_OEM_KEYS` and `OFW_ATTESTER_DIDS`. Without pinned OEM keys Sidekar trusts whatever the configured PDS returns for the author DID; see [SECURITY.md](../SECURITY.md).

## Security notes

- For `container` releases Sidekar needs the Docker CLI and access to the Docker socket, which is equivalent to root on the host. Treat Sidekar's configuration and its PDS URL accordingly.
- `docker load` runs only after all verification has passed.
- Product and version are restricted to safe file-name characters before they are used in paths.
