# Full-stack example

A complete Open Firmware deployment on one machine, under Docker Compose: a real AT Protocol PDS as the distribution center, a publisher, an independent CI attester, Sidekar installing onto a demo workload, and the private IoT control plane.

Demo only. It uses fixed local credentials and binds every port to `127.0.0.1`.

- Presenting it: [`docs/demo-runbook.md`](../../docs/demo-runbook.md)
- Learning from it: [`WALKTHROUGH.md`](./WALKTHROUGH.md)

## Quick start

Needs Docker with Compose v2, Node 20+, Rust (to build `ofw`), `openssl`, `curl`, `bash`.

```bash
# once, from the repository root
pnpm install --frozen-lockfile && pnpm -r build        # only needed for the IoT scripts
cargo build --release --locked --manifest-path cli/Cargo.toml

cd examples/full-stack
./scripts/demo-up.sh                         # keys, images, start, wait until healthy
./scripts/demo-happy-path.sh "Hello"         # OEM-signed, CI-attested release → applied
./scripts/attack-unsigned.sh                 # stolen password, no OEM key → refused
./scripts/demo-reset.sh                      # wipe all state and start clean
```

Then open <http://localhost:8099> (walkthrough UI) and <http://localhost:8080> (the app being updated).

## Services

| Service | Port (127.0.0.1) | Role |
|---------|------------------|------|
| `pds` | 2583 | AT Protocol PDS (`ghcr.io/bluesky-social/pds:0.4`): release records, blobs, gate, channel pointer |
| `plc` | — | Local stand-in for the `plc.directory` DID registry, so the stack runs offline. Does not verify operations. Demo only |
| `bootstrap` | — | One-shot: creates the publisher and CI attester accounts, writes their DIDs to a shared volume |
| `pipeline-runner` | — | CI attester. Logs in as `ci-attester.pds.test`, acks `build` and `test` for each release awaiting the pipeline. Has no publisher credentials; cannot promote |
| `sidekar` | — | Installer. Follows the publisher's channel; requires the pinned OEM key and the CI attester's acks; writes the payload for `demo-site` |
| `demo-site` | 8080 | The workload: shows the text payload of the applied release |
| `control` | 8787 | Private IoT control plane: device join approval, signed and sealed jobs |
| `walkthrough` | 8099 | Live status page with a publish button and an attack button. Holds the publisher password and OEM key (it plays the publisher's workstation) |

All images except the PDS are built locally and run as the non-root user `node`.

## Trust configuration

| Who | Holds | Set by |
|-----|-------|--------|
| Publisher (your shell, `ofw`) | PDS password; OEM private key `.local/oem.pem` | `scripts/demo-setup.sh` |
| CI attester (`pipeline-runner`) | Its own PDS password only | compose |
| Sidekar | Publisher DID, CI attester DID, OEM **public** key | `AUTHOR_DID_FILE`, `OFW_ATTESTER_DIDS`, `OFW_TRUSTED_OEM_KEYS`, `OFW_REQUIRE_OEM_SIGNATURE=1`, `OFW_REQUIRED_PIPELINE_STAGES=build,test`, `OFW_MAX_IMAGE_BYTES` |
| Camera emulator | Control plane job-signing key, pinned at `init` | `OFW_CONTROL_PUBLIC_KEY` |

`scripts/demo-setup.sh` generates `pds.secrets.env`, `.local/oem.pem` and `.env` (the OEM public key for Sidekar, and the base64 private key for the walkthrough container). All three are gitignored. Existing files are never overwritten.

## Scripts

| Script | What it does |
|--------|--------------|
| `demo-setup.sh` | Generate secrets and the OEM key; write `.env` |
| `demo-up.sh [--no-build]` | Setup, `docker compose up --wait`, print DIDs and URLs |
| `demo-reset.sh [--down]` | `down -v`, delete the emulated cameras, start again. Keeps keys and images |
| `demo-happy-path.sh [msg]` | Publish (OEM-signed, CI gate) → CI acks → promote → Sidekar applies → audit. `DEMO_PAUSE=1` waits for Enter before each step |
| `publish-to-pds.sh [msg]` | Same as `demo-happy-path.sh` (old name) |
| `publish-with-pipeline.sh [msg]` | Step 1 only: publish and leave the gate at `awaiting-pipeline` |
| `promote.sh [version]` | Publisher promotion, counting only the CI attester's acks |
| `pipeline-runner-once.sh` | Run the CI attester once from the host (when the container is stopped) |
| `attack-unsigned.sh` | Stolen password, unsigned release, CI skipped → Sidekar refuses |
| `attack-wrong-key.sh` | Stolen password, signed with the attacker's key, passes CI → Sidekar refuses |
| `attack-overwrite.sh` | Re-publish / rewrite a live release → `ofw` refuses, Sidekar and `ofw audit` detect the rewrite |
| `iot-demo.sh` | Camera emulator: factory init → join → admin approve → signed password job applied |
| `attack-rogue-control.sh` | Camera pinned to another control key refuses to enroll |

Versions are assigned automatically: one patch above the highest version ever published for `demo-site` (releases are immutable, so a version is never reused). Set `VERSION=…` to choose one.

Every attack script exits 0 when the attack was blocked and 1 if it was not.

## Credentials (local example only)

| Account | Handle | Password |
|---------|--------|----------|
| Publisher | `publisher.pds.test` | `publisher-pass-change-me` |
| CI attester | `ci-attester.pds.test` | `ci-pass-change-me` |
| Control plane admin | — | `OFW_ADMIN_TOKEN=local-dev-admin-token` |

The scripts pass the PDS password to `ofw` through `OFW_PASSWORD`, never on the command line. Do not reuse any of this outside the example.

## Network use

Building needs the network: base images and npm packages for the image builds, `ghcr.io/bluesky-social/pds:0.4`, crates for `ofw`, and `pnpm install` for the IoT scripts. Once built, nothing in the stack needs the internet — including `demo-reset.sh` — because account DIDs are registered with the local `plc` service instead of `plc.directory`.

## Tear down

```bash
docker compose down          # stop, keep state
./scripts/demo-reset.sh --down   # stop and delete all state (keeps keys and images)
```

Volumes written by images from before the non-root change are owned by root and cause `EACCES`; `demo-reset.sh` removes them.
