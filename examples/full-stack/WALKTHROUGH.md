# Guided walkthrough — Open Firmware full stack

Run the sample stack and watch a software update travel from a publisher to a running app, with each party checking it on the way. No AT Protocol knowledge needed.

For a timed presenter script, see [`docs/demo-runbook.md`](../../docs/demo-runbook.md).

## The story

1. A **publisher** signs an update with an OEM key and publishes it to a **PDS** (an AT Protocol server; here it is the distribution center).
2. An **independent CI account** builds and tests it, and records "build passed, test passed" for that exact release in its own repository.
3. The publisher **promotes** the release. Only now does the channel point at it.
4. **Sidekar**, the agent on the target machine, trusts nobody's word: it checks the OEM signature against a key it has pinned, checks the CI account's acks, checks every hash, and only then applies the update.
5. The **demo site** shows the new payload.

The payload here is a line of text. The same chain carries firmware images, packages and container tarballs.

## Start

```bash
# once, from the repository root
cargo build --release --locked --manifest-path cli/Cargo.toml
pnpm install --frozen-lockfile && pnpm -r build     # for the IoT part

cd examples/full-stack
./scripts/demo-up.sh
```

`demo-up.sh` generates local secrets and an OEM key, builds the images, starts everything and waits for the health checks. It prints the two account DIDs and the OEM public key.

| Open | What it is |
|------|------------|
| <http://localhost:8099> | Walkthrough page: live status, what Sidekar will do with each release |
| <http://localhost:8080> | The app being updated |

## Step 1 — a good release

```bash
./scripts/demo-happy-path.sh "Hello from a signed release"
```

The script prints each command it runs. In order:

| Step | Who | Command | Result |
|------|-----|---------|--------|
| 1 | Publisher | `ofw publish … --require-pipeline --stages build,test --oem-key .local/oem.pem` | Release created, gate `awaiting-pipeline`, channel unchanged |
| 2 | CI account | (the `pipeline-runner` container) | Two ack records in the CI account's repository, naming the release CID |
| 3 | Publisher | `ofw pipeline-promote --rkey … --attester-did <CI DID>` | Gate `ready`, channel points at the release |
| 4 | Sidekar | — | `applying package 1.0.1 …`, `applied 1.0.1`; the site changes |
| 5 | Anyone | `ofw audit … --probe-blobs --trusted-oem-key <key>` | `OK — metadata and every blob verified` |

Run it again with another message: each run publishes the next version.

To take the steps by hand:

```bash
./scripts/publish-with-pipeline.sh "Hello after tests"   # step 1 only
./scripts/promote.sh                                     # step 3; fails until CI has acked
```

Or use the **Publish signed release** button on <http://localhost:8099>. The page signs with the same OEM key and promotes when the CI acks arrive.

## Step 2 — try to break it

Each script plays an attacker who has stolen the publisher's PDS password. That is enough to write anything into the publisher's repository. It should not be enough to change what runs.

```bash
./scripts/attack-unsigned.sh     # no OEM key, CI skipped
./scripts/attack-wrong-key.sh    # signs with a key of their own, goes through CI
./scripts/demo-happy-path.sh "A good release again"
./scripts/attack-overwrite.sh    # replace the bytes of the live release
```

| Attack | The PDS | Sidekar |
|--------|---------|---------|
| Unsigned, CI skipped | Accepts; gate `ready`, channel moved | `REFUSED … PIPELINE_INCOMPLETE` — no ack from the CI account. `ofw audit` adds `OEM_SIG_MISSING` |
| Signed with the attacker's key, passed CI | Accepts; promoted on real CI acks | `REFUSED … OEM_SIG_INVALID: oem public key is not in trustedOemKeys` |
| Publish the same version again | `ofw` refuses: `already exists … releases are immutable` | — |
| Rewrite the release record through the raw API | Accepts; the record gets a new content ID | Refuses: the channel pins the old content ID. `ofw audit` reports `GATE_MISMATCH` and `OEM_SIG_INVALID` |

After each script the demo site still shows the last good payload. The walkthrough page marks the attacker's releases **REFUSED** with the reason. The **Simulate attack** button on that page runs the first attack.

After an attack the channel points at a release Sidekar refuses, so updates stall until the publisher publishes the next good release — run `demo-happy-path.sh` again. An attacker with the password can stall updates; they cannot install anything.

## Step 3 — the IoT control plane

Releases are public. Device management is not: joining a fleet, credentials and job delivery go through the private control plane on port 8787.

```bash
./scripts/iot-demo.sh
```

| Step | Who | What happens |
|------|-----|--------------|
| 1 | Factory | Camera gets an identity; the control plane's job-signing key is pinned into its profile |
| 2 | Camera | Boots and sends a signed join request |
| 3 | Admin | `ofw-util list-pending`, `ofw-util approve <joinId>` |
| 4 | Admin | `ofw-util set-password <fingerprint> <password>` — the control plane signs the job and encrypts it to the device |
| 5 | Camera | Verifies the signature against the pinned key, applies, acks (`acked_ok`) |

```bash
./scripts/attack-rogue-control.sh
```

A camera whose factory profile pins a different control key reaches this control plane. An admin approves it and queues a password change. The camera logs `control plane key does not match the pinned key — refusing enrollment` and the job stays `pending`.

The admin CLI by hand:

```bash
export OFW_CONTROL_URL=http://127.0.0.1:8787
export OFW_ADMIN_TOKEN=local-dev-admin-token      # the value in docker-compose.yml
node ../../packages/utility/dist/cli.js list-devices
node ../../packages/utility/dist/cli.js list-jobs
node ../../packages/utility/dist/cli.js control-key
```

`GET /v1/meta` shows the job-signing public key and counters. It does not return the admin token.

## Step 4 — `ofw` by hand

```bash
export OFW_PDS=http://127.0.0.1:2583
export OFW_IDENTIFIER=publisher.pds.test
export OFW_PASSWORD=publisher-pass-change-me       # env var, not --password
OFW=../../cli/target/release/ofw

printf 'manual publish' > /tmp/payload.txt
$OFW publish --product demo-site --version 9.0.0 --kind package --file /tmp/payload.txt \
  --require-pipeline --stages build,test \
  --oem-key .local/oem.pem --oem-key-id demo-oem-1 --yes

# wait a few seconds for the CI container, then:
CI_DID=$(node scripts/_pds.mjs did ci-attester.pds.test)
$OFW pipeline-promote --rkey demo-site-9.0.0-stable --attester-did "$CI_DID"
```

Things `ofw` refuses, by design:

- publishing a product/version/channel that already exists;
- `--stages` without `--require-pipeline`;
- moving the channel to an older version without `--allow-downgrade` (after publishing 9.0.0, the scripts continue from 9.0.1);
- `pipeline-skip` on a failed gate without `--override-failed`;
- logging in over plain http to a non-loopback host without `--allow-insecure-http`.

## In production

| In this example | In production |
|-----------------|---------------|
| Text payload | Firmware image, package, container tarball |
| Local PDS on port 2583, local `plc` service | Your PDS over https; the public PLC directory |
| `publisher.pds.test` with a fixed password | Your handle with an app password in a secret store |
| OEM key in `.local/oem.pem` | Offline or HSM-held key; only the public key is on devices |
| `pipeline-runner` container that passes everything | Your CI running real builds and tests, then `ofw pipeline-ack` |
| Walkthrough container holding the publisher's keys | Nothing like it; the publish step runs in your release job |

## Stop, reset

```bash
docker compose down            # stop, keep state
./scripts/demo-reset.sh        # delete all state and start clean (keeps keys and images)
```

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `required variable OFW_TRUSTED_OEM_KEYS is missing a value` | `.env` not written yet. Use `./scripts/demo-up.sh`, or run `./scripts/demo-setup.sh` before `docker compose` |
| `EACCES` / `permission denied` in `sidekar`, `control` or `demo-site` logs | Volumes left by older root-running images. `./scripts/demo-reset.sh` |
| Happy path stops at step 2, `timed out waiting for acks` | `pipeline-runner` is not running: `docker compose up -d pipeline-runner` |
| `not promoted: required pipeline acks not present yet` | CI has not acked yet; wait, or run `./scripts/pipeline-runner-once.sh` |
| Site does not change after a good publish | `docker compose logs --tail 20 sidekar` and look for `REFUSED` or `tick error` |
| `attack-overwrite.sh`: `the channel points at … not a good release` | The previous step was an attack. Run `demo-happy-path.sh` first |
| IoT scripts: `TypeScript packages are not built` | From the repository root: `pnpm install --frozen-lockfile && pnpm -r build` |
