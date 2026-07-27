# Architecture

## Distribution center = PDS

All releases are AT Protocol **repository records + blobs** on the **author’s Personal Data Server**. There is no separate product “catalog” as source of truth.

```
Publisher (ofw / @open-firmware/host)
        │  createSession · uploadBlob · createRecord/putRecord
        ▼
   AT Protocol PDS  ◄── Sidekar / IoT client poll listRecords · getBlob
        │
        └── signed commits (DID keys) + content digests
```

## Runtimes

| Runtime | Package | Docker |
|---------|---------|--------|
| IoT / field edge | `@open-firmware/client` | **No** |
| Server host | `@open-firmware/sidekar` | Optional (`docker load` for container kind) |

Same release chain and Phase A/B verification for both.

## Artifact kinds

`firmware` · `package` · `container` · `deployment` · `bundle`  
See [spec-release-chain.md](./spec-release-chain.md).

## Libraries

| Package | Responsibility |
|---------|----------------|
| `core` | Chunk, hash, audit, windows |
| `atproto-lite` | XRPC client |
| `host` | Publish API |
| `client` | Resolve, audit, download |
| `sidekar` | Host agent loop + apply |
| `ofw` (Rust) | Operator/CI CLI |

## Deploy model (SMB / EC2 / on-prem)

Default: **Sidekar reconciles** by polling the PDS for the latest ready release for its product/channel.  
GitHub Actions only **builds and publishes** — it does not SSH to hosts or rebuild on the host.
