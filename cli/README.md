# `ofw` — Open Firmware CLI (Rust)

Operator CLI that publishes **immutable, content-addressed releases** (SHA-256 per part and for the whole image, optionally **OEM-signed with Ed25519**) plus a mutable gate and channel pointer to an **AT Protocol PDS** (the distribution center).

Early prototype: the record formats and flags may still change.

```bash
# from the repository root
cargo install --path cli --locked
# or, without installing
cargo build --release --locked --manifest-path cli/Cargo.toml   # → cli/target/release/ofw
```

Requires Rust 1.85 or newer.

## Commands

| Command | Purpose |
|---------|---------|
| `ofw release` | Guided interactive wizard |
| `ofw publish` | Upload an artifact and create the release (ready immediately, or `--require-pipeline`) |
| `ofw pipeline-ack` | Record a CI stage result (`passed` / `failed` / `skipped`) for a release |
| `ofw pipeline-promote` | Publisher: check the required acks, then set the gate to `ready` and move the channel |
| `ofw pipeline-skip` | Publisher: force the gate to `ready` and move the channel, ignoring acks |
| `ofw audit` | Verify a published release: metadata, gate, optional OEM signature and blob download |

`ofw <command> --help` lists every flag.

## Credentials

Give the app password through the `OFW_PASSWORD` environment variable, or pipe it with `--password-stdin`. On a terminal, `ofw` prompts when neither is set.

```bash
export OFW_PDS=https://pds.example.com
export OFW_IDENTIFIER=you.example.com
read -rs OFW_PASSWORD && export OFW_PASSWORD
# or: pass-manager show ofw | ofw publish --password-stdin ...
```

`--password <value>` still works but prints a warning: command-line arguments are visible to other local users (`ps`, `/proc`).

Plain `http://` is accepted only for loopback addresses (`localhost`, `127.0.0.1`, `::1`). For any other host `ofw` refuses to log in unless you pass `--allow-insecure-http` (or `OFW_ALLOW_INSECURE_HTTP=1`); an anonymous `ofw audit` over plain http prints a warning.

## Publish

```bash
ofw publish \
  --product my-app \
  --version 1.2.0 \
  --kind container \
  --file ./image.tar \
  --yes --json
```

- **Releases are create-only.** Publishing a product/version/channel that already exists fails; publish a new version instead. The gate and channel pointer are the only mutable records, and they are updated with compare-and-swap.
- `--yes` skips the confirmation prompt. Without it, `ofw` asks on a terminal and refuses to publish when stdin is not a terminal. `--dry-run` plans and checks without writing.
- `--product` allows letters, digits, `.`, `_`, `-`; `--version` must be semver; `--kind` is one of `firmware`, `package`, `container`, `deployment`, `bundle`. Empty files are refused.
- The artifact is read in a streaming fashion (one chunk in memory, `--chunk-size`, default 4 MiB, at most 512 parts).
- With `--json`, stdout is one JSON object (`uri`, `cid`, `rkey`, `authorDid`, `partCount`, `imageSha256`, `imageSize`, `gate`, `dryRun`, `channelRkey`, `channelUpdated`, `oemSigned`, `oemPublicKey`, `warnings`); logs go to stderr.
- The channel pointer never moves to an older version unless you pass `--allow-downgrade`.

### OEM signature (Ed25519)

```bash
openssl genpkey -algorithm ed25519 -out oem.pem          # keep this offline / in a secret store
ofw publish ... --oem-key ./oem.pem --oem-key-id factory-1
```

`--oem-key` takes a PKCS#8 PEM file; the `OFW_OEM_KEY` variable may hold either a path or the PEM text (for CI secrets). The release then carries `oemSignature` (`alg`, `publicKey`, `sig`, optional `keyId`; raw key and signature as unpadded base64url) over `v1|product|version|channel|imageSha256|imageSize`. This is the same format `@open-firmware/core` signs and verifies; `cli/tests/ts_interop.rs` checks the two implementations against each other. The public key is printed after publishing (`oemPublicKey` in JSON).

Without `--oem-key` a release is **not** signed by an OEM key; its integrity then rests on the SHA-256 digests and on the publisher's AT Protocol repository.

## Audit

```bash
ofw audit --repo you.example.com --rkey my-app-1.2.0-stable \
  --probe-blobs --trusted-oem-key <base64url public key>
```

- `--repo` is a DID or a handle (resolved through the PDS given by `--pds`).
- Checks the part layout, sizes, digests' format, the declared part count, and that the gate exists, is `ready` and refers to this exact release CID.
- `--probe-blobs` downloads every part and verifies each part's SHA-256 **and** the SHA-256 and size of the assembled image.
- `--trusted-oem-key` (repeatable, or `OFW_TRUSTED_OEM_KEYS`) pins OEM keys: the release must then carry a valid signature from one of them. Without pinned keys, a signature is reported as `unpinned` — the key comes from the record itself, so it proves nothing on its own — and a present-but-invalid signature still fails.
- `--free-space <bytes>` fails the audit if the image does not fit.

Exit codes: `0` the release passed, `2` the audit found problems (do not download or apply), `1` the audit could not be completed (network error, unreadable gate, unknown handle, bad arguments). `--json` prints the report (`ok`, `issues[]`, `gate`, `authorDid`, `partCount`, `declaredPartCount`, `blobsProbed`, `oemSignature`).

## Pipeline / CI gate

```bash
# 1) Publisher uploads; the gate is awaiting-pipeline and the channel does not move.
ofw publish ... --require-pipeline --stages build,test --yes

# 2) CI — ideally a separate account — records results in its own repo.
ofw pipeline-ack --rkey my-app-1.2.0-stable --author-did did:plc:publisher \
  --stage build --result passed
ofw pipeline-ack --rkey my-app-1.2.0-stable --author-did did:plc:publisher \
  --stage test --result passed

# 3) Publisher promotes, counting only acks written by the CI DID.
ofw pipeline-promote --rkey my-app-1.2.0-stable --attester-did did:plc:ci
```

How promotion decides:

- An ack counts only if it names the release's URI **and CID** (so an ack never covers a release record that was replaced afterwards) and was written by one of the `--attester-did` accounts. Per stage, the newest ack wins.
- `pipeline-promote` exits non-zero and writes nothing while a required stage is missing, when the newest ack of a required stage is `failed`, when the gate is `failed`, or when the release record no longer matches the CID the gate was created for.
- **Without `--attester-did`, only acks in the publisher's own repo count.** That is self-attestation: `ofw` prints a warning, sets `"selfAttested": true` in JSON and records it in the gate's `reason`.
- Auto-promote: when the *publisher account itself* runs `pipeline-ack` with `passed` or `skipped`, `ofw` then runs the same promotion check (self-attested unless `--attester-did` is given). It promotes only if every required stage is satisfied; `--no-promote` disables this. An ack written by a different account never changes the gate — the publisher must run `pipeline-promote`.
- A `failed` ack from the publisher account sets the gate to `failed`. A failed gate is not promoted again by later acks.
- `pipeline-skip` is the explicit override: it writes gate `ready` (reason `pipeline skipped by publisher`) and moves the channel regardless of acks. It needs `--override-failed` for a failed gate, and like every channel move, `--allow-downgrade` to go back to an older version.

`pipeline-ack --json` reports what actually happened: `promoted` (true only if the gate and channel were written), `promotion` (`promoted` / `waiting` / `refused` / `not-attempted`), `gate` (state after the command, `null` when this account cannot write it), `missingStages`, `selfAttested`.

## Environment

| Variable | Used by | Description |
|----------|---------|-------------|
| `OFW_PDS` | all | PDS base URL (required) |
| `OFW_IDENTIFIER` | all (optional for `audit`) | Handle or email to log in with |
| `OFW_PASSWORD` | all (optional for `audit`) | App password |
| `OFW_ALLOW_INSECURE_HTTP` | all | `1` to allow plain http to a non-loopback host |
| `OFW_PRODUCT` | `publish` | Product id |
| `OFW_VERSION` | `publish` | Semver version |
| `OFW_CHANNEL` | `publish` | Channel (default `stable`) |
| `OFW_KIND` | `publish` | Artifact kind (default `package`) |
| `OFW_SKIP_PIPELINE` | `publish` | `1`: no CI gate (this is already the default) |
| `OFW_REQUIRE_PIPELINE` | `publish` | `1`: same as `--require-pipeline`; wins over skip |
| `OFW_PIPELINE_STAGES` | `publish` | Comma-separated required stages (needs require-pipeline) |
| `OFW_OEM_KEY` | `publish`, `release` | OEM key: PEM file path or PEM text |
| `OFW_OEM_KEY_ID` | `publish`, `release` | Label stored as `oemSignature.keyId` |
| `OFW_AUTHOR_DID` | `pipeline-ack` | Publisher DID when CI is a different account |
| `OFW_ATTESTER_DIDS` | `pipeline-promote`, `pipeline-ack` | Comma-separated CI DIDs whose acks count |
| `OFW_REPO` | `audit` | Publisher repo (DID or handle) |
| `OFW_TRUSTED_OEM_KEYS` | `audit` | Comma-separated pinned OEM public keys |

Boolean variables accept `1/true/yes/on` and `0/false/no/off`; an empty value means unset.

## GitHub Actions

See [`examples/github-actions-publish.yml`](examples/github-actions-publish.yml). Secrets: `OFW_PDS`, `OFW_IDENTIFIER`, `OFW_PASSWORD`; optionally `OFW_CI_IDENTIFIER` / `OFW_CI_PASSWORD` for an independent CI attester.

## Local stack

With [`../examples/full-stack`](../examples/full-stack) running (a real PDS on `127.0.0.1:2583`), from the repository root:

```bash
./examples/full-stack/scripts/publish-to-pds.sh "payload text"
```

It uses the bootstrap publisher account on the local PDS — the same protocol as production.

## Tests

```bash
cd cli
cargo test --locked
```

- Unit tests cover chunking, the audit checks, the pipeline gate decisions, input validation and signing vectors.
- `tests/e2e.rs` runs the real binary (publish → audit → ack → promote, plus the failure paths) against an in-process mock PDS.
- `tests/ts_interop.rs` cross-checks OEM signatures with the TypeScript implementation under Node. It is skipped when `../packages/core/dist` has not been built (`pnpm --filter @open-firmware/core build`); set `OFW_REQUIRE_TS_INTEROP=1` to require it.
