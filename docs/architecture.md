# Architecture

This describes the code as it is on this branch (0.1.0, early prototype). Planned work is listed at the end and in the [README roadmap](../README.md#roadmap-and-known-limitations).

## The distribution center is a PDS

Releases are AT Protocol repository records and blobs in the publisher's account on a Personal Data Server. There is no separate catalog service.

```
Publisher (ofw CLI or @open-firmware/host)
        │  createSession with an app password
        │  uploadBlob (one per part)
        │  createRecord(release)            create-only, never rewritten
        │  put gate, put channel            compare-and-swap (swapRecord)
        ▼
   AT Protocol PDS
        ▲
        │  getRecord(channel) → getRecord(release, cid) → getRecord(gate)
        │  listRecords(pipelineAck) → getBlob (each part)
Consumer (@open-firmware/client, used by Sidekar)
```

What the consumer checks at each step is specified in [spec-release-chain.md](./spec-release-chain.md). In short: author allow-list, product/channel binding, CID pinning, gate state, attester acks, optional pinned-key OEM signature, then length, SHA-256 and blob CID for every part and the digest of the whole image.

The consumer talks to the PDS URL it is configured with. It does not resolve the author's DID or verify repository commit signatures today; see [SECURITY.md](../SECURITY.md).

## Two planes

| Plane | Carried by | Holds |
|-------|-----------|-------|
| Public | PDS records and blobs | Releases, gates, channel pointers, CI acks |
| Private | `apps/server` HTTP API | Join approvals, encrypted and signed jobs (passwords, firmware offers) |

The private plane is described in [private-plane.md](./private-plane.md).

## Runtimes

| Runtime | Package | Docker needed |
|---------|---------|---------------|
| Device / edge | `@open-firmware/client` (library) with `@open-firmware/iot` for identity and jobs | No |
| Server host | `@open-firmware/sidekar` | Only for `container` releases |

Both use the same release records and the same verification code.

## Artifact kinds

The record field `kind` is one of `firmware`, `package`, `container`, `deployment`, `bundle`; anything else is refused. What Sidekar does with each is in [sidekar.md](./sidekar.md). Only `package`, `firmware` (staging) and `container` have real handlers.

## Components

| Component | Responsibility | State |
|-----------|----------------|-------|
| `ofw` (Rust, `cli/`) | Publish, CI gate commands, audit | Working, tested end to end against a mock PDS |
| `core` | Chunking, hashing, metadata audit, pipeline policy, OEM signatures, semver guard, service-window evaluation | Working, tested. Service windows have no caller. |
| `atproto-lite` | XRPC client: session refresh, pagination, compare-and-swap, capped blob download, blob CIDs | Working, tested. Identity resolution and OAuth metadata helpers are unused. |
| `host` | TypeScript publish API | Working, tested; fewer safeguards than `ofw` |
| `client` | Resolve channel, verify, download | Working, tested |
| `sidekar` | Poll loop and apply handlers | Working for three kinds |
| `iot` | Device identity, factory reset, join, job authentication | Working, tested |
| `utility` (`ofw-util`) | Admin CLI for the control plane | Working, tested |
| `apps/server` | Control plane API | Working, tested; single process, file store |
| `fleet` | Writers for device, enrollment, policy, offer and admin-grant records | Writers only; nothing consumes the records |
| `appview` | In-memory release index with an HTTP listener method | Minimal; no entrypoint; not used by any consumer |
| `packages/cli` | Re-export of `host` | Placeholder |
| `apps/web` | Admin UI | Empty scaffold |

## Deploy model

Pull-based. Sidekar polls the channel pointer for one product and channel and applies a release when the pointer names a newer version that passes verification. Nothing pushes to hosts, and there is no inbound webhook. CI's job ends at publishing and, optionally, recording stage results.

## Authentication

- **Publishing:** `com.atproto.server.createSession` with an app password, refreshed with `refreshSession` when the access token expires.
- **Reading:** anonymous XRPC reads from the configured PDS.
- **Control plane:** admin bearer token; devices sign each request with their Ed25519 key.
- **OAuth:** not implemented. `docs/oauth-client-metadata.json` is a client-metadata template for a future interactive web app; it uses `openfirmware.app` as a placeholder origin, and `publisherClientMetadata(origin)` in `atproto-lite` generates the same document for any origin.

## Build and release automation

- `.github/workflows/ci.yml`: on pushes to `main`/`master`, pull requests, a weekly schedule and manual dispatch. Jobs: TypeScript on Node 20 and 22 (install with frozen lockfile, build, typecheck, lint, tests, emulator end-to-end); Rust CLI (fmt, clippy with warnings as errors, tests, release build) on a pinned toolchain; Docker builds of the server and example-stack images with a check that none runs as root; an advisory, non-blocking dependency audit (`pnpm audit`, `cargo audit`).
- `.github/workflows/release.yml`: on a `v*` tag. Runs the full CI, checks the tag against the crate version, builds `ofw` for Linux x86-64, Linux arm64 and macOS arm64, writes `SHA256SUMS`, attests build provenance, and creates a GitHub Release. npm publishing is a separate job that is skipped unless the repository variable `NPM_PUBLISH_ENABLED` is `true`, and then waits for approval on a protected environment.
- Neither workflow has run on GitHub yet; they have been checked locally only. The repository's own pipeline does not publish Open Firmware releases through `ofw`. `cli/examples/github-actions-publish.yml` is an example workflow for projects that want to do that.

## Not built yet

DID and commit-signature verification; a wider OEM signature; a default firmware-offer handler; Sidekar `deployment`/`bundle` handling, rollback and self-update; consumers for fleet records and service windows; a persistent AppView; the web UI; OAuth login.
