# Security

Open Firmware is an early prototype (0.1.0). It has not had an external security review. This document states what the code on this branch checks, what it does not, and how to report a problem.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes, latest only. Pre-1.0: breaking changes are possible. |

## Reporting a vulnerability

> **PLACEHOLDER — the maintainers must fill this in before publishing: security contact address (for example `security@<your-domain>`).** No contact address has been set up yet. Until one is listed here, use GitHub's private vulnerability reporting ("Report a vulnerability" under the repository's Security tab) if it is enabled.

Please report privately, and do not open a public issue for anything that could lead to installation of unauthorised software, compromise of a fleet, or credential theft. Include the affected component, steps to reproduce, and your assessment of impact. Allow a reasonable period for a fix before disclosure.

## Release trust model (public plane)

Releases are AT Protocol records and blobs in the publisher's repository on a PDS. Consumers are `@open-firmware/client` and the Sidekar agent built on it.

### What a consumer verifies before applying

1. **Author allow-list.** The release's DID is parsed from its `at://` URI and must be in `trustedAuthors` (default: the one configured author DID).
2. **Channel binding.** The channel pointer record and the release record must both name the product and channel the consumer asked for. The record key alone is not trusted for this.
3. **CID pinning.** The release is fetched with the CID named in the channel pointer, and the returned URI and CID must match. The same pinned record is used for download; it is not re-fetched by URI.
4. **Gate.** The gate record must be `ready` and must reference the same release URI and CID. A gate that cannot be read (timeout, server error) is a failure, not a pass. A release reached through a channel pointer with no gate record at all is treated as ready, because the pointer is only written at promotion; a release fetched directly by URI needs a gate record.
5. **Pipeline acks.** If the release declares a strict pipeline, or the consumer sets `attesterDids`, every required stage needs a `passed` or `skipped` ack bound to the release URI **and CID**; the newest ack per stage wins. With `attesterDids` set, only acks stored in those accounts' repositories count, the policy is at least `strict` whatever the release record says, and the consumer may supply its own stage list.
6. **Metadata audit** ("Phase A", no download): record type, digest format, part sequence, offsets, sizes summing to the image size, blob sizes, an image size cap (default 1 GiB).
7. **OEM signature**, when the consumer has `trustedOemKeys`: the release must carry a valid Ed25519 signature made by one of those keys. The key embedded in the record counts only if it is in the pinned list. `requireOemSignature` with no pinned keys refuses everything.
8. **Bytes** ("Phase B"): each part's length, SHA-256 and blob CID (CIDv1, raw, sha2-256), then the SHA-256 and size of the assembled image. Downloads are capped at the declared part size.
9. **Version order.** The agent applies only a version strictly newer (semver) than the one it last applied.

### What the OEM signature binds

The signed message is the UTF-8 string

```
v1|{product}|{version}|{channel}|{imageSha256 lowercase hex}|{imageSize}
```

Because product and channel are in the signed message and the consumer checks both against what it asked for, a signature for one product or channel cannot be presented for another, and it cannot be attached to different bytes.

It does **not** cover: the artifact `kind`, the part layout, the pipeline policy and required stages, the gate, the record's CID, or the author DID. Someone who can write to the publisher's repository (the PDS operator, or anyone with the publisher's password) but does not hold the OEM key therefore **can**:

- re-serve an older, genuinely signed release; an agent that has already applied a newer version ignores it, a freshly installed agent would accept it;
- withhold new releases (the optional `maxChannelAgeSec` staleness check relies on an unsigned timestamp);
- republish the same signed bytes under a different `kind`, changing how Sidekar handles them (for example `docker load` instead of a file copy);
- change the declared pipeline policy, which matters only to consumers that have not set `attesterDids`.

They **cannot** make a consumer with pinned OEM keys accept bytes the OEM did not sign.

### What is not verified today

- **AT Protocol commit signatures and DID resolution.** The client reads records with `getRecord` from the PDS URL it was configured with. It does not resolve the DID to find the PDS or signing key, and does not verify signed repository commits. `resolveIdentity` exists in `atproto-lite` and is unused. Consequently, **with no pinned OEM keys the configured PDS and the network path to it are fully trusted**: the digests prove the bytes match the record, not that the record is authentic.
- **Transport.** The TypeScript client and Sidekar do not refuse plain `http://` PDS URLs. (`ofw` does, except for loopback, unless `--allow-insecure-http` is given.)
- **Attester independence across servers.** Attester acks are read from the same configured PDS, so the attester account must live there and that PDS is trusted to report them honestly.
- **Service windows, update offers, fleet policy and admin-grant records** are defined and can be written, but no component reads or enforces them.
- The AppView is an index only and is not consulted by the client or Sidekar.

### Publisher side

- `ofw` logs in with an app password (`createSession`, with refresh). Treat that password as the publisher identity. Prefer `OFW_PASSWORD` or `--password-stdin`; `--password` on the command line prints a warning.
- Releases are create-only: publishing an existing product/version/channel fails. Gate and channel records are written with compare-and-swap.
- `ofw` promotion rules (acks bound to CID, attester DIDs, self-attestation flagged, failed gates not re-promoted, downgrade guard) are described in [docs/pipeline-runner.md](./docs/pipeline-runner.md). The TypeScript `@open-firmware/host` library binds acks to the CID but does not have the downgrade guard or the failed-gate refusal.
- Publisher and consumer bypass switches are separate: `--skip-pipeline` / `OFW_SKIP_PIPELINE` affect publishing only; `OFW_CONSUMER_SKIP_PIPELINE=1` is the consumer-side emergency bypass and is off by default.
- Pipeline acks are a workflow control, not a second signature. They add assurance only when the attester is a different account from the publisher and consumers list it in `attesterDids`.
- Interactive OAuth login is not implemented. `docs/oauth-client-metadata.json` and `publisherClientMetadata()` are a metadata template only.

## Control plane (private plane)

`apps/server` is an HTTP API for enrollment and jobs; `packages/iot` is the device side; `packages/utility` is the admin client.

### Admin authentication

- One bearer token for all admin routes, compared in constant time.
- Precedence: `OFW_ADMIN_TOKEN` in the environment always wins; otherwise the token stored in the data file; otherwise a random token is generated on first start. The token is printed only if `OFW_REVEAL_ADMIN_TOKEN=1`.
- The data file holds the admin token and the job-signing private key. It is written with mode `0600` via a temporary file and atomic rename.

### Device enrollment

- A join request is signed with the device's Ed25519 key. The server recomputes the fingerprint as `sha256(product|ed25519PublicKey)`, derives the mnemonic it shows the admin from that fingerprint, and requires `createdAt` to be within the allowed clock skew.
- Pending joins are capped (`OFW_MAX_PENDING_JOINS`), expire (`OFW_JOIN_TTL_MS`), and can be approved only while pending. Request bodies are size-limited and fields are format-checked.
- Approval is a human decision: the admin compares the mnemonic with the one printed for the device.

### Jobs

- The server has an Ed25519 **job-signing key**, generated on first start and published at `GET /v1/meta`. A device pins the public key either at the factory (`controlPublicKey` in the factory profile) or, if none was provisioned, the first time it sees itself enrolled.
- Each job payload is encrypted to the device's X25519 key (ephemeral X25519, SHA-256 of the shared secret as the key, AES-256-GCM). The server stores only the ciphertext after creating it.
- The server signs the JSON array `["ofw-job-v1", fingerprint, jobId, kind, issuedAt, sealed.epk, sealed.nonce, sealed.ct]`. The device verifies this against the pinned key before decrypting, checks that the decrypted `kind` equals the signed one, and refuses unsigned, wrongly signed or malformed jobs without acknowledging them.
- The device keeps a replay record (the last 256 job ids and a time floor) outside the area wiped by factory reset, so a captured job is not applied twice, including after a reset.
- `firmware.apply` (raw bytes pushed through the control plane) is rejected by both server and device. `firmware.offer` carries only a release URI and digest; the device passes it to an application callback and acknowledges `unsupported` if there is none.

### Device requests

- Job pull and job ack carry `x-ofw-fingerprint`, `x-ofw-timestamp`, `x-ofw-nonce`, `x-ofw-signature`. The signature covers `"{METHOD} {path}|{fingerprint}|{timestamp}|{nonce}"`, plus `|{status}` for an ack.
- The timestamp must be within `OFW_AUTH_SKEW_MS` (default 5 minutes), the device must have an active enrollment, and each nonce is accepted once.

### Known weaknesses

- **No TLS in the server.** It listens on plain HTTP; the device agent and `ofw-util` default to `http://127.0.0.1:8787` and do not refuse non-TLS URLs. Deploy behind a TLS-terminating proxy. Job contents stay confidential and authentic over plain HTTP, but the admin token does not.
- **Trust on first use** when no control key is provisioned at the factory: the device pins whatever key the endpoint presents at first enrollment.
- **The nonce cache is in memory.** After a server restart a captured device request can be replayed until its timestamp leaves the skew window. Job application on the device is still at-most-once.
- **The serial number is self-asserted** by the device and not bound to its key. Only the fingerprint (product + public key) is verified.
- **Unauthenticated routes:** `GET /v1/meta` (record counts and the public control key) and `GET /v1/devices/by-fingerprint/{fp}` (enrollment status for a fingerprint).
- **No revocation.** There is no API to deactivate an enrollment or rotate the job-signing key. After a factory reset the server still holds the device's active enrollment, so the device is treated as enrolled again without a new approval.
- **The ack error text is not covered** by the device signature (the status is).
- **Single admin token**, no roles, no audit log. The store is a JSON file serialised within one process; running two server processes on one file is unsafe.
- **Device keys are files** (mode `0600`), not hardware-backed. The default factory secret is a public development constant; the library warns when it is used.
- Sidekar's `container` path needs the Docker socket, which is equivalent to root on the host.

## In scope

Reports are especially welcome for:

- bypass of the metadata audit or of the length / digest / CID checks
- acceptance of a release from an author outside `trustedAuthors`, or for the wrong product or channel
- installation of a release whose gate is not `ready`, or whose required attester acks are missing
- OEM signature bypass when keys are pinned
- a device applying a job not signed by its pinned control key, or applying a job twice
- access to admin routes without the token, or leakage of the token, app passwords or private keys into logs or records
