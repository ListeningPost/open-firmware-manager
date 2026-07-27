# Release chain specification

Shared contract for **publishers** (Rust `ofw` CLI, GitHub Actions) and **consumers** (Sidekar, IoT client, TypeScript `@open-firmware/core`).

The **distribution center is an AT Protocol PDS**. Releases are repository records + blobs in the **author’s** account. Authenticity = PDS commit signatures bound to the author’s DID, plus content digests on records.

## Collections

| NSID | Role |
|------|------|
| `app.openfirmware.firmware.release` | Root manifest for one product version |
| `app.openfirmware.firmware.chunk` | Ordered payload pieces (reply chain) |
| `app.openfirmware.firmware.pipelineAck` | Optional CI/build/test acknowledgments |
| `app.openfirmware.firmware.releaseSeal` | Optional seal after full publish |

## Publish order (mandatory)

1. Read artifact bytes; compute `imageSha256` (SHA-256 hex, lowercase) and `imageSize`.
2. Split into chunks of `chunkSize` (default `524288` bytes / 512 KiB; last chunk may be shorter).
3. Create **release** record with `status: "publishing"`, full digests, `chunkCount`.
4. For each chunk `seq = 0 .. chunkCount-1`:
   - `uploadBlob` chunk bytes → blob ref (CID).
   - Create **chunk** record with `reply.root` = release strongRef, `reply.parent` = previous chunk (or release for `seq=0`).
5. **Pipeline gate (optional):**
   - If CI is required: set `status: "awaiting_pipeline"`, `requirePipelineAcks: true`, `requiredPipelineStages: ["build","test",…]`, `pipelinePolicy: "strict"`.
   - CI posts **`pipelineAck`** records for each stage (`result: passed|failed|skipped`).
   - When all required stages are `passed` or `skipped`, set `status: "ready"` (and optional seal).
   - If a required stage `failed`, set `status: "failed"`.
   - **Skip pipeline:** set `status: "ready"`, `requirePipelineAcks: false`, `pipelinePolicy: "skipped"` immediately after chunks (default for simple publishes / `ofw publish --skip-pipeline`).
6. Consumers **must refuse** install while `status != "ready"`.
7. If `requirePipelineAcks` / `pipelinePolicy: strict`, consumers also require matching acks unless they explicitly **skip pipeline check** (emergency only).

### CI flow (example)

```
ofw publish --require-pipeline --stages build,test   → awaiting_pipeline
ofw pipeline-ack --stage build --result passed
ofw pipeline-ack --stage test  --result passed       → auto-promote ready
Sidekar installs
```

### Skip CI

```
ofw publish --skip-pipeline   → ready immediately after chunks
# or consumer: OFW_SKIP_PIPELINE=1 / skipPipelineCheck: true
```

## Release record fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `version` | string | yes | Semver, e.g. `1.2.3` |
| `product` | string | yes | Stable product id |
| `kind` | string | yes | `firmware` \| `package` \| `container` \| `deployment` \| `bundle` |
| `createdAt` | datetime | yes | ISO-8601 |
| `imageSha256` | string | yes | 64 hex chars |
| `imageSize` | integer | yes | Total bytes |
| `chunkCount` | integer | yes | Number of chunk records |
| `chunkSize` | integer | no | Default chunk size hint |
| `mimeType` | string | no | Default `application/octet-stream` |
| `channel` | string | yes | `stable` \| `beta` \| `dev` |
| `status` | string | yes | `publishing` \| `awaiting_pipeline` \| `ready` \| `failed` |
| `requirePipelineAcks` | boolean | no | Gate install on pipeline acks |
| `requiredPipelineStages` | string[] | no | e.g. `build`, `test` (default those two when required) |
| `pipelinePolicy` | string | no | `strict` \| `optional` \| `skipped` |
| `changelog` | string | no | |
| `platform` | string | no | e.g. `linux/amd64` |
| `runtime` | string | no | `iot` \| `sidekar` \| `any` |

## Pipeline ack fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `release` | strongRef | yes | Points at release root |
| `stage` | string | yes | `build` \| `test` \| `lint` \| `security_scan` \| `sign` \| `promote` \| `custom` |
| `stageId` | string | no | When stage is custom |
| `result` | string | yes | `passed` \| `failed` \| `skipped` |
| `createdAt` | datetime | yes | |
| `runUrl` | string | no | CI URL |
| `commit` | string | no | Git SHA |
| `summary` | string | no | Short note |

**Record key (rkey):** deterministic  
`{product}-{version}-{channel}` with non `[A-Za-z0-9._~-]` replaced by `-`.

## Chunk record fields

| Field | Type | Required |
|-------|------|----------|
| `reply.root` | strongRef | yes |
| `reply.parent` | strongRef | yes |
| `seq` | integer | yes (0-based) |
| `blob` | blob | yes |
| `sha256` | string | yes (64 hex) |
| `byteOffset` | integer | yes |
| `byteLength` | integer | yes |
| `createdAt` | datetime | yes |

### Layout invariants

- `byteOffset[0] == 0`
- `byteOffset[i] == byteOffset[i-1] + byteLength[i-1]`
- `sum(byteLength) == imageSize`
- `blob.size == byteLength` when size is present
- Exactly `chunkCount` chunks with `seq` `0..chunkCount-1`
- Every chunk authored by the **same DID** as the release

## Phase A (metadata audit) — before download

Consumers must validate the above invariants using **records only**, plus optional free-space and blob-availability probes. Fail closed.

Error codes (aligned with `@open-firmware/core`):  
`AUTHOR_MISMATCH`, `CHAIN_BROKEN`, `COUNT_MISMATCH`, `SEQ_GAP`, `LAYOUT_INVALID`, `SIZE_MISMATCH`, `DIGEST_MISSING`, `DIGEST_INVALID`, `INCOMPLETE_PUBLISH`, `INSUFFICIENT_SPACE`, `BLOB_UNAVAILABLE`, …

## Phase B — download and apply

1. Fetch each blob; verify length and `sha256`.
2. Assemble in `seq` order; verify `imageSha256` and `imageSize`.
3. Apply by `kind` (firmware flash, container load, etc.).

## Publisher entry points

| Entry | Tool |
|-------|------|
| Laptop | `ofw release` (guided) or `ofw publish` |
| CI | `ofw publish` in GitHub Actions |
| Consumer | Sidekar / client poll PDS for latest ready release |

## Demo vs production

Same record shape and crypto story. Only the **PDS base URL** and credentials change.

- **Demo:** local/private PDS or example stack documented in `cli/README.md`
- **Production:** your operated PDS (`OFW_PDS`, app password / session)
