# Release chain specification

Shared contract for **publishers** (Rust `ofw` CLI, GitHub Actions, `@open-firmware/host`) and **consumers** (Sidekar, IoT client, TypeScript `@open-firmware/core`).

The **distribution center is an AT Protocol PDS**. Releases are repository records + blobs in the **author’s** account.

Authenticity has two layers:

1. **AT Protocol**: DID + PDS-signed commits, record CIDs, blob CIDs. Clients resolve identity, pin CIDs on `getRecord`, and recompute blob CIDs.
2. **OEM**: optional detached Ed25519 signature over `v1|{product}|{version}|{channel}|{imageSha256}|{imageSize}`, verified against keys provisioned on the device. This is independent of PDS session keys.

AppViews are an **untrusted index**. They never replace (1) or (2).

## Collections

| NSID | Key | Role |
|------|-----|------|
| `app.openfirmware.firmware.release` | `any` `{product}-{version}-{channel}` | **Immutable** manifest + `parts[]` blobs |
| `app.openfirmware.firmware.gate` | `any` same rkey as release | Mutable CI/publish state (`awaiting-pipeline` \| `ready` \| `failed`). Sidecar; update with `swapRecord`. |
| `app.openfirmware.firmware.channel` | `any` `{product}-{channel}` | Mutable pointer to the current **ready** release. This is the consumer catalog. |
| `app.openfirmware.firmware.pipelineAck` | `tid` | CI acknowledgments |
| `app.openfirmware.firmware.releaseSeal` | `tid` | Optional seal |
| `app.openfirmware.actor.declaration` | `literal:self` | Publisher discovery record |

Do **not** reply-chain chunk records. Payload slices live in `release.parts`.

## Publish order (mandatory)

1. Read artifact bytes; compute `imageSha256` / `imageSize`.
2. Split into parts of `chunkSize` (default **4 MiB**, max **50 MiB**). Prefer one part when the file fits.
3. `uploadBlob` each part.
4. **Once**, `createRecord` / `putRecord`+`swapRecord` the **immutable** release with `parts[]` already filled. Never mutate this record to flip status (that would invalidate strongRefs).
5. `putRecord` the **gate** sidecar (`awaiting-pipeline` or `ready`) with `swapRecord`.
6. When ready, `putRecord` the **channel** pointer with `swapRecord`.
7. Optional: pipeline acks, then promote gate+channel.
8. Consumers follow the **channel pointer**, `getRecord` the release **with cid**, then Phase A/B.

### Skip CI

```
ofw publish --skip-pipeline   → gate=ready + channel updated after parts
```

### Require CI

```
ofw publish --require-pipeline --stages build,test   → gate=awaiting-pipeline
ofw pipeline-ack --stage build --result passed
ofw pipeline-ack --stage test  --result passed       → gate=ready + channel
```

Consumers **must refuse** install unless the gate is `ready` (or they are following a channel pointer that is only written on ready).

## Phase A (metadata) — before download

Records only. Do not download blobs unless `probeBlobs` is explicitly set.

Fail closed: `$type`, author DID from `at://`, layout, digests, optional OEM signature, gate state.

## Phase B — download and apply

1. `sync.getBlob` each part.
2. Verify `byteLength`, hex SHA-256, **and** blob CID (`CIDv1` raw sha2-256).
3. Assemble; verify `imageSha256`.
4. Apply by `kind`.

## Record key

`{product}-{version}-{channel}` with non `[A-Za-z0-9._~-]` replaced by `-`.

Lexicon `key` is `any`, **not** `literal:self`.
