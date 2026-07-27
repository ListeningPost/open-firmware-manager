# Guided walkthrough — Open Firmware full stack

This walkthrough is the **main way to understand the project** by running the sample `docker compose` stack.

You do **not** need to know AT Protocol jargon to follow along.

---

## What you will see

| Open in browser | What it is |
|-----------------|------------|
| **http://localhost:8099** | **Guided walkthrough** (start here) |
| **http://localhost:8080** | Example app that gets updated |
| **http://localhost:2583/xrpc/_health** | PDS health (distribution center) |

---

## Story in plain English

1. **You publish** a signed software update (here: a short text “package”).
2. It is stored on a **PDS** — the official AT Protocol server for this stack.
3. **Sidekar** (an agent on the “server”) checks for new updates.
4. It **verifies** the update is complete and correct.
5. It **applies** the update to the example app.
6. The **front page** shows the new message.

That is the same pattern production uses for firmware, packages, and containers.

---

## Start the stack

From the repo:

```bash
cd examples/full-stack

# One-time secrets for the local PDS
./scripts/gen-pds-secrets.sh

# Build and start everything
docker compose up --build -d
```

What starts:

| Service | Role (simple) |
|---------|----------------|
| **pds** | The signed software storehouse |
| **bootstrap** | Creates an example publisher account once |
| **sidekar** | Watches the storehouse and updates the app |
| **demo-site** | Fake “your product” with a front page |
| **walkthrough** | This tour, with live status |

Open: **http://localhost:8099**

---

## Step 1 — Open the walkthrough

Open **http://localhost:8099**

You will see live service status (all Docker containers) and **buttons to trigger updates**.

---

## Step 2 — Trigger an update from the page

On the walkthrough page:

1. Type a message (or keep the default).
2. Click **Publish now (skip CI)** — release becomes `ready` immediately.
3. Wait a few seconds — Sidekar installs and the front page message updates.
4. Or click **Publish with CI gate** — status is `awaiting_pipeline` until the **pipeline-runner container** acks build+test, then Sidekar installs.

You can also still use the CLI:

```bash
./scripts/publish-to-pds.sh "Hello from the CLI"
./scripts/publish-with-pipeline.sh "Hello after CI"
```

---

## Step 3 — Publish again

```bash
./scripts/publish-to-pds.sh "Second update — Sidekar will pick this up"
```

Sidekar only installs **newer** ready versions. Each publish should show up on the front page within a few seconds.

---

## Step 4 — CI / pipeline (runner ≠ Sidekar)

**Sidekar only installs.** A separate **pipeline runner** (or GitHub Actions) posts build/test results.

| Role | Job |
|------|-----|
| Publisher | `ofw publish` |
| **Runner / CI** | run tests → `pipeline-ack` |
| Sidekar | install when `ready` |

### Fast path (no CI)

```bash
./scripts/publish-to-pds.sh "Hello (skip CI)"
```

### CI path (visible on walkthrough :8099)

```bash
./scripts/publish-with-pipeline.sh "Hello after tests"
# status = awaiting_pipeline — watch counters/stages on http://localhost:8099
# compose service pipeline-runner auto-acks build+test (demo)
# or: ./scripts/pipeline-runner-once.sh
# then Sidekar installs when ready
```

Walkthrough shows per-release: status, required stages, each ack result, and gate summary.

## Step 5 — Relate this to real life

| In this example | In production |
|-----------------|---------------|
| Text package as the “artifact” | Firmware image, container tar, deploy bundle |
| Local PDS on port 2583 | Your real PDS URL |
| `publisher.pds.test` | Your company handle + app password |
| demo-site front page | Your cameras / servers / apps |
| `./scripts/publish-to-pds.sh` | `ofw publish` in CI or on your laptop |

GitHub Actions would only **build and publish**.  
Sidekar on each host would **pull and install** — it does not rebuild from git.

---

## Step 6 — Optional: publish with the Rust CLI yourself

```bash
# from monorepo root
cargo build --release --manifest-path cli/Cargo.toml

printf 'manual cli publish' > /tmp/payload.txt

./cli/target/release/ofw publish \
  --pds http://127.0.0.1:2583 \
  --identifier publisher.pds.test \
  --password publisher-pass-change-me \
  --product demo-site \
  --version 9.0.0 \
  --file /tmp/payload.txt \
  --yes
```

---

## IoT management (also in this monorepo)

Control plane is on **http://localhost:8787** when started with compose (service `control`).

Synthetic camera e2e (join → approve → password → firmware → factory reset):

```bash
# from monorepo root
pnpm --filter @open-firmware/iot-camera-emulator test:e2e
```

Admin CLI (`ofw-util`):

```bash
export OFW_CONTROL_URL=http://127.0.0.1:8787
export OFW_ADMIN_TOKEN=local-dev-admin-token   # compose default
node packages/utility/dist/cli.js list-pending
node packages/utility/dist/cli.js approve <joinId>
```

---

## Stop and clean up

```bash
cd examples/full-stack
docker compose down -v
```

`-v` deletes local volumes (PDS data, messages, publisher config).

---

## Troubleshooting

| Symptom | Try |
|---------|-----|
| Walkthrough or front page down | `docker compose ps` and `docker compose logs` |
| Publish fails login | Wait for bootstrap: `docker compose logs bootstrap` |
| Message never changes | `docker compose logs sidekar` — look for `applied` |
| Stale state | `docker compose down -v` then `up --build -d` again |

---

## One-sentence summary

**Publish signed software to the PDS → Sidekar verifies and applies it → your app updates — that is Open Firmware.**
