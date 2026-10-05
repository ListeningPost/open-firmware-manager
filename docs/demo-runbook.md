# Demo runbook

A presenter's script for the `examples/full-stack` demo: one good release, three attacks that fail closed, and the IoT control plane. The scripts themselves run for about 40 seconds in total; allow 6 to 8 minutes with narration. Every command below was run against this branch from a clean reset, and the output snippets are from that run, trimmed (DIDs, keys and content IDs differ on every reset).

All commands run from `examples/full-stack` unless a line says otherwise.

## The pitch in one line

Stealing the publisher's password lets an attacker write to the distribution server. It does not let them change what devices run: the device also requires a signature from an OEM key the attacker does not have, and an attestation from a CI account the attacker does not control.

## Before the day

Do this on the presenting laptop, on a network, at least once. Afterwards the demo runs with no internet.

| Step | Command (from the repository root) | Measured |
|------|------------------------------------|----------|
| Tools | Docker with Compose v2 (tested: Docker 29, Compose v5.6), Node 22, pnpm 9.15, Rust, `openssl`, `curl`, `bash` | — |
| TypeScript packages (IoT scripts need them) | `pnpm install --frozen-lockfile && pnpm -r build` | not timed |
| `ofw` CLI | `cargo build --release --locked --manifest-path cli/Cargo.toml` | 23 s with dependencies already compiled; a from-scratch build was not timed |
| Images, keys, first start | `cd examples/full-stack && ./scripts/demo-up.sh` | see below |
| Dry run | everything in [The script](#the-script), then `./scripts/demo-reset.sh` | allow 10 min |

`demo-up.sh` on first run pulls `ghcr.io/bluesky-social/pds:0.4` (about 580 MB) and builds seven small images. Measured on the preparation machine: image build 13 s with a warm build cache, 31 s with `--no-cache` (base image already downloaded; a first-ever build also downloads `node:22-alpine`); first start including the PDS pull 55 s. Later starts take 15–17 s.

Rebuild `ofw` if it was built before this branch: the scripts use flags (`--oem-key`, `--attester-did`) and the `OFW_PASSWORD` variable that older binaries do not have. `ofw publish --help | grep oem-key` must print a line.

### Ports

All bound to `127.0.0.1`. Nothing else may be listening on them.

| Port | Service | Show it? |
|------|---------|----------|
| 8099 | Walkthrough page | Yes, second browser tab or half the screen |
| 8080 | Demo site (the "device") | Yes |
| 2583 | PDS | Only `/xrpc/_health` if asked |
| 8787 | IoT control plane | Only `/v1/meta` if asked |

### Pre-flight, 10 minutes before

```bash
cd examples/full-stack
./scripts/demo-reset.sh
```

Expected, in about 25 s (10 s to stop, 15 s to start):

```
stack is up (15s)
  publisher        publisher.pds.test  did:plc:roqacieno6b5rodejr3mkpus
  CI attester      ci-attester.pds.test         did:plc:p2ds3dgpjph2m5myz6gbzhit
  OEM public key   yT9ERjWnVgDfKzdN0O6NZY03-dIRr5LsOeI-DCFzblM  (private key: examples/full-stack/.local/oem.pem)

  walkthrough UI   http://localhost:8099
  demo site        http://localhost:8080
```

Then:

- [ ] `docker compose ps` — seven services `Up (healthy)`; `bootstrap` is `Exited (0)`, which is correct.
- [ ] Browser tab 1: <http://localhost:8080> shows "Waiting for Sidekar to apply a signed release from the PDS…".
- [ ] Browser tab 2: <http://localhost:8099> shows every service `up`, 0 releases.
- [ ] Terminal font large; `clear`. Wi-Fi can be off.
- [ ] Optional: `export DEMO_PAUSE=1` makes every script wait for Enter before each step, so you can talk first. Without it the scripts run straight through.

Do not publish anything during pre-flight if you want the first release on stage to be `1.0.1`.

## The script

Timings are script run time without pauses.

### 1. A good release — 6 s

```bash
./scripts/demo-happy-path.sh "Hello, investors"
```

| Step on screen | Say |
|----------------|-----|
| `1/5 Publisher signs with the OEM key and publishes` | "The publisher signs the release with an OEM key that lives on their machine, and uploads it. It is on the server, but no device is offered it yet." |
| `2/5 Independent CI … attests` | "A separate CI account builds and tests it and records the result against this exact release. CI has no publisher credentials." |
| `3/5 Publisher promotes` | "Now the publisher promotes it. The tool only counts acks written by the CI account." |
| `4/5 Sidekar re-checks everything itself` | "The agent on the device trusts none of that. It checks the signature against the key it has pinned, checks the CI acks, checks every hash, then applies." |
| `5/5 Anyone can audit` | "And anyone can audit a release with no credentials at all." |

Expected output (trimmed):

```
== 1/5  Publisher signs with the OEM key and publishes demo-site 1.0.1 (CI gate required) ==
   $ ofw publish --product demo-site --version 1.0.1 --kind package --file payload.txt \
   $       --require-pipeline --stages build,test --oem-key .local/oem.pem --oem-key-id demo-oem-1 --yes
   Creating immutable release demo-site-1.0.1-stable…
     gate:    awaiting-pipeline
     oem key: yT9ERjWnVgDfKzdN0O6NZY03-dIRr5LsOeI-DCFzblM (Ed25519)
   published. gate = awaiting-pipeline; the channel has NOT moved, so no device sees it yet.

== 2/5  Independent CI (ci-attester.pds.test) runs build + test and attests the result ==
   ack  stage=build  result=passed  by=did:plc:p2ds3dgpjph2m5myz6gbzhit
   ack  stage=test  result=passed  by=did:plc:p2ds3dgpjph2m5myz6gbzhit
   CI attested build,test.

== 3/5  Publisher promotes — ofw counts only acks written by the CI account ==
   $ ofw pipeline-promote --rkey demo-site-1.0.1-stable --attester-did did:plc:p2ds3dgpjph2m5myz6gbzhit
   promoted — gate ready + channel demo-site-stable updated: at://did:plc:…/demo-site-1.0.1-stable
   gate = ready; channel demo-site/stable -> 1.0.1

== 4/5  Sidekar re-checks everything itself, then applies ==
   sidekar | applying package 1.0.1 at://did:plc:…/app.openfirmware.firmware.release/demo-site-1.0.1-stable
   sidekar | package applied → /site/message.txt
   sidekar | applied 1.0.1
   demo site (http://localhost:8080) now says: "Hello, investors"

== 5/5  Anyone can audit the release — no credentials needed ==
     OEM signature: valid, trusted key yT9ERjWnVgDfKzdN0O6NZY03-dIRr5LsOeI-DCFzblM
     OK — metadata and every blob verified (per-part and whole-image SHA-256).

DONE  demo-site 1.0.1 is live (6s).
```

Switch to the browser: tab 1 shows "Hello, investors" (it refreshes every 5 s); tab 2 shows the release as **ACCEPTED — live on the channel**.

### 2. Attack: stolen password, unsigned release — 4 s

```bash
./scripts/attack-unsigned.sh
```

Say: "Now I am an attacker with the publisher's password. I push my own release straight to the stable channel, no signature, no CI. Watch the server accept it."

```
 ATTACK  stolen publisher password — unsigned release, CI skipped
   demo site currently says: "Hello, investors"

== Attacker publishes demo-site 1.0.2 straight to stable (no --oem-key, no CI gate) ==
   Release ready (pipeline skipped). Channel demo-site-stable updated.
   the PDS accepted it: gate = ready, channel demo-site/stable -> 1.0.2

== What Sidekar did ==
   sidekar | REFUSED demo-site 1.0.2 at://did:plc:…/demo-site-1.0.2-stable - PIPELINE_INCOMPLETE: missing passed/skipped ack for stage "build"; PIPELINE_INCOMPLETE: missing passed/skipped ack for stage "test"
   demo site still says: "Hello, investors"

BLOCKED  the attacker's release is on the PDS, and nothing installed it.

== Independent check: ofw audit with the real OEM key pinned ==
     OEM signature: none
     FAILED — do not download/apply:
       [OEM_SIG_MISSING] release has no oemSignature but --trusted-oem-key requires one
   exit code 2 = do not install
```

Say: "The server said yes. The device said no, twice over: no attestation from CI, no OEM signature." Tab 2 now shows 1.0.2 in red, **REFUSED**.

### 3. Attack: the attacker signs with their own key and passes CI — 8 s

```bash
./scripts/attack-wrong-key.sh
```

Say: "A smarter attacker signs the release — with a key they just made — and lets it go through CI. CI is honest: the code builds, the tests pass. Every server-side check is green."

```
 ATTACK  stolen publisher password — release signed with the attacker's own key, passed through CI
   attacker key:      ndVUVPDkZGz55WzDOWSZob56nbqbPRd-mfDAT_5P5kM
   Sidekar trusts:    yT9ERjWnVgDfKzdN0O6NZY03-dIRr5LsOeI-DCFzblM

== CI attests it (the code builds and the tests pass), the attacker promotes it ==
   promoted — gate ready + channel demo-site-stable updated: at://did:plc:…/demo-site-1.0.3-stable
   gate = ready, channel demo-site/stable -> 1.0.3: every server-side check passed

== What Sidekar did ==
   sidekar | REFUSED demo-site 1.0.3 at://did:plc:…/demo-site-1.0.3-stable - OEM_SIG_INVALID: oem public key is not in trustedOemKeys
   demo site still says: "Hello, investors"

BLOCKED  the attacker's release is on the PDS, and nothing installed it.
       [OEM_SIG_INVALID] oem public key ndVUVPDkZGz55WzDOWSZob56nbqbPRd-mfDAT_5P5kM is not a trusted OEM key
   exit code 2 = do not install
```

Say: "A valid signature from the wrong key is worth nothing. The device only accepts the key it was given."

### 4. Recover, then attack: replace a live release — 6 s + 4 s

```bash
./scripts/demo-happy-path.sh "Back to a good release"
./scripts/attack-overwrite.sh
```

Say (first command): "The real publisher ships the next version and the fleet moves on. The attacker's releases stay on the server, refused."

Say (second command): "Last try: do not publish a new version, swap the bytes of the one that is already trusted."

```
 ATTACK  replace the bytes behind the live release demo-site 1.0.4

== a) Publish 1.0.4 again with different bytes ==
   Error: release demo-site-1.0.4-stable already exists (cid bafyreiahgd4rirxzlbbpe563kw4wfvhsvxt4qrj5lcj6yk5m6fnz5ieeze); releases are immutable — publish a new version
   refused (exit 1): a published release cannot be replaced.

== b) Skip ofw: rewrite the release record in place with the raw PDS API ==
   the PDS accepted the rewrite.
   content ID before: bafyreiahgd4rirxzlbbpe563kw4wfvhsvxt4qrj5lcj6yk5m6fnz5ieeze
   content ID after:  bafyreihzgcxmfew4pca663aas5id3gevoywxy37aa33smoeaek43dutahu

== What Sidekar did ==
   sidekar | tick error RecordNotFound: Could not locate record: at://did:plc:…/demo-site-1.0.4-stable
   demo site still says: "Back to a good release"

BLOCKED  the attacker's release is on the PDS, and nothing installed it.
       [GATE_MISMATCH] gate refers to release cid bafyreiahgd…, but the release record is bafyreihzgc…
       [OEM_SIG_INVALID] oemSignature: signature mismatch
   exit code 2 = do not install
```

Say: "Our tool refuses. Going around the tool works on the server, but every record is content-addressed: the channel, the CI acks and the signature all point at the old content, so the device will not touch the new one."

`attack-overwrite.sh` needs the channel to point at a good release. Run it straight after an attack and it stops with `the channel points at … not a good release`; run `demo-happy-path.sh` first.

### 5. IoT: join, approve, signed job — 3 s

```bash
./scripts/iot-demo.sh
```

Say: "Releases are public. Managing devices is not. A camera leaves the factory with an identity and the control plane's key pinned. It can ask to join; a human approves; from then on it only obeys jobs signed by that key."

```
== 1/5  Factory: provision camera CAM-0001, pin the control plane's job-signing key ==
   "serial": "CAM-0001",
   "mnemonic": "exit-bond-ever-camp-area-grim",
   pinned control key: zrKj_YnpL4A7nHJwUvvCoci4EHYk2QMgNHgMiFRz9_E

== 2/5  Device boots and asks to join ==
   camera | joinRequest: join_0c7120b5212905c4

== 3/5  Admin reviews the pending request and approves it ==
   $ ofw-util approve join_0c7120b5212905c4
   approved enr_0fd6739c9bb0f939

== 4/5  Admin rotates the camera password: a job signed by the control plane, sealed to this device ==
   job job_87600ce0ed5548a1 credential.set for 8d1a8a29fedb…

== 5/5  Device verifies the job signature, applies it, acks ==
   camera | job job_87600ce0ed5548a1 credential.set: ok
   job_87600ce0ed5548a1	credential.set	acked_ok	credential.set for 8d1a8a29fedb…

DONE  CAM-0001 joined, was approved, and applied a signed job.
```

Tab 2, bottom card "IoT control plane", lists the camera as `active` and the job as "applied by device".

### 6. Optional IoT attack: rogue control plane — 4 s

```bash
./scripts/attack-rogue-control.sh
```

Say: "Point a camera at a control plane it was not built for. The operator there approves it and sends a password change."

```
   camera | control plane key does not match the pinned key — refusing enrollment
   job status on the rogue control plane: pending
   camera password: unchanged (factory default)

BLOCKED  the camera never enrolled, so the job was never fetched or applied.
```

### 7. Close

```bash
./scripts/demo-happy-path.sh "Thank you"
```

Say: "Four attacks, nothing installed, and the fleet is one command away from the next good release."

## Browser-only variant

If you would rather click than type, <http://localhost:8099> has two buttons that do steps 1 and 2:

- **Publish signed release (OEM key + CI)** — a car drives Publish → CI/CD → Install → Live; about 6 s.
- **Simulate attack: stolen password, unsigned** — the car stops at Install with "Sidekar REFUSED: OEM signature missing…; no CI attestation for build, test"; about 8 s (it waits 6 s to prove nothing gets installed).

The page and the scripts share the same PDS and the same version sequence, so they can be mixed.

## Reset between runs

```bash
./scripts/demo-reset.sh          # about 25 s; keeps keys and images; needs no network
```

It removes all containers and volumes (accounts, releases, Sidekar state, the site message, control-plane devices) and the emulated cameras, then starts again. The next release is `1.0.1`.

A reset is not required between runs: versions keep counting up, and each good release supersedes whatever came before. Reset when you want a clean release list on the walkthrough page.

When finished: `docker compose down` (keeps state) or `./scripts/demo-reset.sh --down` (clean).

## Questions you may get

- **"So an attacker with the password can stall updates?"** Yes. After attacks 2–4 the channel points at something every device refuses, until the publisher ships the next good version. They can deny service on the channel; they cannot install anything. Recovery is one publish.
- **"Is CI really independent here?"** It is a separate account with its own password in a separate container, and it never has publisher credentials. The demo CI passes everything; in production it is your pipeline running `ofw pipeline-ack`.
- **"Where is the OEM key?"** `examples/full-stack/.local/oem.pem` on this laptop. Sidekar has only the public key. The walkthrough web page also holds the private key so its button can sign — that is a demo shortcut and is the reason the page is bound to localhost.
- **"Is that a real AT Protocol server?"** Yes, the stock Bluesky PDS image. Only the DID directory (`plc`) is a local stand-in so the demo runs offline.

## Troubleshooting

Failures seen while preparing this demo, and what fixes them.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `docker compose up` prints `required variable OFW_TRUSTED_OEM_KEYS is missing a value: run ./scripts/demo-setup.sh first` | Compose was run directly before the OEM key and `.env` existed | Use `./scripts/demo-up.sh` (it runs the setup) |
| `ofw` rejects `--oem-key` or `--attester-did` as unknown | `ofw` binary built before this branch (the one found on the preparation machine was; it was rebuilt before use, so the exact message was not captured) | `cargo build --release --locked --manifest-path cli/Cargo.toml` from the repository root |
| `demo-happy-path.sh` stops at step 2: `timed out waiting for acks (build, test missing)` | `pipeline-runner` is stopped | `docker compose up -d pipeline-runner`, then `./scripts/promote.sh` |
| `Error: not promoted: required pipeline acks not present yet (missing: build, test)` | `promote.sh` ran before CI acked | Wait 3 s and run it again |
| `attack-overwrite.sh`: `the channel points at … which is not a good release` | Previous step was an attack | `./scripts/demo-happy-path.sh "…"` first |
| Site does not change after a good publish | Sidekar refused or cannot reach the PDS | `docker compose logs --tail 20 sidekar`; look for `REFUSED` or `tick error` |
| `Error: release … already exists` from a script | `VERSION=` was set to a version that exists | Unset `VERSION`; the scripts pick the next free one |
| Services exit with `EACCES` / `permission denied` on `/data`, `/site` or `/var/lib/sidekar` | Volumes created by the older root-running images (not reproduced here; the stack was started from clean volumes) | `./scripts/demo-reset.sh` |
| `docker compose up` fails to bind 2583, 8080, 8099 or 8787 (not reproduced here) | Another program on a demo port | Stop it; find it with `ss -ltnp \| grep -E '2583\|8080\|8099\|8787'` |
| `docker compose down -v` takes about 40 s | Default 10 s stop timeout; the containers do not handle SIGTERM | Use `./scripts/demo-reset.sh` (2 s timeout, about 10 s) |
| IoT scripts: `TypeScript packages are not built` | `packages/*/dist` missing | `pnpm install --frozen-lockfile && pnpm -r build` from the repository root |
| `docker compose logs pds` is full of `"level":50` lines | The PDS logs every `RecordNotFound` lookup as an error; Sidekar polls for a channel that does not exist yet | Ignore; do not show the PDS log on stage |

General first move when something looks wrong: `docker compose ps`, then `docker compose logs --tail 30 <service>`. If in doubt, `./scripts/demo-reset.sh` costs 25 s.

## If Docker misbehaves on stage

In order of preference:

1. **Reset** — `./scripts/demo-reset.sh`, 25 s. Talk through the architecture slide while it runs. Fixes anything stateful.
2. **Restart the daemon is too slow; run the tests instead.** They exercise the same refusals in-process, with no Docker:

   ```bash
   # from the repository root
   pnpm --filter @open-firmware/sidekar test      # 1 s: "refuses an unsigned release…", "refuses a release signed by a key that is not trusted", "with attesterDids, waits for attester acks…"
   pnpm test:e2e                                  # IoT camera: join → approve → signed job → forged job refused
   ```

3. **Show the recording.** Before the event, record one clean pass of [The script](#the-script) (`asciinema rec`, or a screen capture) and keep screenshots of the walkthrough page after step 4. Play it and narrate.

Do not try to debug Docker networking live.

## What this demo does not show

- The demo CI passes every release; no failing-stage path is scripted (`ofw pipeline-ack --result failed` exists, but was not exercised against this stack).
- Sidekar applies a text file. Container and firmware kinds are not exercised here (`DOCKER_LOAD=0`, no Docker socket is mounted).
- One device, one channel, no staged rollout.
- The `plc` service accepts any DID operation without verifying it. It exists only so the stack runs offline.
