# `ofw` — Open Firmware CLI (Rust)

Production CLI to publish **cryptographically signed** release chains to an **AT Protocol PDS** (the distribution center).

```bash
cd cli && cargo install --path .
```

## Commands

| Command | Purpose |
|---------|---------|
| `ofw release` | Guided wizard |
| `ofw publish` | Upload artifact (`--skip-pipeline` default, or `--require-pipeline`) |
| `ofw pipeline-ack` | CI/build/test acknowledgment mid-pipeline |
| `ofw pipeline-skip` | Force ready without remaining CI acks |
| `ofw audit` | Phase A metadata audit |

### Pipeline / CI gate

```bash
# 1) Upload bits; wait for CI messages
ofw publish ... --require-pipeline --stages build,test --yes
# status = awaiting_pipeline

# 2) From CI jobs:
ofw pipeline-ack --rkey my-app-1.2.0-stable --stage build --result passed
ofw pipeline-ack --rkey my-app-1.2.0-stable --stage test  --result passed
# auto-promotes to ready when all required stages pass

# Skip CI entirely (default for simple publishes):
ofw publish ... --skip-pipeline --yes

# Or skip after the fact:
ofw pipeline-skip --rkey my-app-1.2.0-stable
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `OFW_PDS` | yes | PDS base URL |
| `OFW_IDENTIFIER` | yes | Handle / email |
| `OFW_PASSWORD` | yes | App password |
| `OFW_PRODUCT` | for publish | Product id |
| `OFW_VERSION` | for publish | Semver |

## Publish

```bash
ofw publish \
  --pds https://pds.example.com \
  --identifier you.example.com \
  --password "$OFW_PASSWORD" \
  --product my-app \
  --version 1.2.0 \
  --kind container \
  --file ./image.tar \
  --yes
```

## GitHub Actions

See `examples/github-actions-publish.yml`. Secrets: `OFW_PDS`, `OFW_IDENTIFIER`, `OFW_PASSWORD`.

## Local stack

With `examples/full-stack` running (real PDS on `:2583`):

```bash
./examples/full-stack/scripts/publish-to-pds.sh "payload text"
```

Uses the bootstrap publisher account on the local PDS — same protocol as production.
