# Architecture

## Distribution center = PDS

All releases are AT Protocol **repository records + blobs** on the **author’s Personal Data Server**. There is no separate product catalog as source of truth.

```
Publisher (ofw / @open-firmware/host)
        │  createSession (bots/CI) or OAuth (interactive)
        │  uploadBlob · createRecord(release, immutable)
        │  putRecord(gate, swap) · putRecord(channel, swap)
        ▼
   AT Protocol PDS  ◄── Sidekar / client: getRecord(channel) · getRecord(release, cid) · getBlob
        │
        └── DID · commit signatures · blob CIDs · optional OEM Ed25519
```

AppView (`@open-firmware/appview`) implements `app.openfirmware.firmware.getLatest` / `listReleases` / `getRelease` as an **index**. Clients re-verify against the author repo.

## Runtimes

| Runtime | Package | Docker |
|---------|---------|--------|
| IoT / field edge | `@open-firmware/client` | **No** |
| Server host | `@open-firmware/sidekar` | Optional (`docker load` for container kind) |

Same release record and Phase A/B for both.

## Artifact kinds

`firmware` · `package` · `container` · `deployment` · `bundle`

## Libraries

| Package | Responsibility |
|---------|----------------|
| `core` | Chunk, hash, audit, pipeline, OEM signatures, windows |
| `atproto-lite` | XRPC: refresh, cursors, swap, identity, CID, XRPCError |
| `host` | Publish API |
| `client` | Resolve channel, audit, download |
| `appview` | Untrusted query index |
| `fleet` | Device/enrollment/policy writers |
| `sidekar` | Host agent loop + apply |
| `ofw` (Rust) | Operator/CI CLI |

## Deploy model

Default: **Sidekar reconciles** by `getRecord` on `app.openfirmware.firmware.channel` for its product/channel. GitHub Actions only **builds and publishes**.

## Auth

- Headless `ofw` / CI: `com.atproto.server.createSession` + app password, with `refreshSession`.
- Interactive apps: ATProto OAuth (`docs/oauth-client-metadata.json`, scope `include:app.openfirmware.authPublisher blob:*/*`).
