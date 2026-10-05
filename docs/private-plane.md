# Public plane and private plane

## Public: the PDS

Release, gate, channel and pipeline-ack records, and the blobs they reference. Nothing secret belongs here: PDS records are readable by anyone who can reach the server.

Lexicons also exist for device identity, device status, enrollment, fleet policy, update offers and admin grants, and `@open-firmware/fleet` has functions that write them. Nothing in the control plane writes these records today and nothing reads them; they are groundwork for a future fleet view.

## Private: the control plane

`apps/server` is a small HTTP API that holds what must not be public: the join approval queue and jobs carrying secrets.

```
ofw-util (admin)  ── bearer token ──▶  control server  ◀── signed join / pull / ack ──  device agent
                                             │
                                             └── jobs: encrypted to the device, signed by the server
```

The server is plain HTTP. Run it behind a TLS-terminating proxy.

### Lifecycle

1. **Factory.** The device gets a profile: Ed25519 identity key, X25519 encryption key, fingerprint, mnemonic, default password, control endpoint and, ideally, the control plane's public key. See [factory-provisioning.md](./factory-provisioning.md).
2. **Join.** The device posts a signed join request. The server verifies the signature, recomputes the fingerprint from product and public key, and queues it.
3. **Approve.** An admin lists pending joins with `ofw-util list-pending`, compares the mnemonic with the device's, and runs `ofw-util approve <joinId>`.
4. **Pin.** The device polls its enrollment status. Once enrolled it checks the server's job-signing key against the one pinned at the factory, or pins the presented key if none was provisioned.
5. **Jobs.** The admin creates a job (for example `ofw-util set-password <fingerprint> <password>`). The device pulls pending jobs, verifies, decrypts, applies and acknowledges each.

### Job format

A job as delivered to the device:

```
{ id, kind, issuedAt, sealed: { v: 1, epk, nonce, ct }, signature }
```

- `sealed` is the JSON payload encrypted to the device's X25519 key: ephemeral X25519 key agreement, SHA-256 of the shared secret as the AES-256-GCM key. The server keeps only this ciphertext once the job is created.
- `signature` is the server's Ed25519 signature over the canonical string `JSON.stringify(["ofw-job-v1", fingerprint, id, kind, issuedAt, sealed.epk, sealed.nonce, sealed.ct])`.

The device refuses, without decrypting or acknowledging, any job that is unsigned, malformed, signed by another key, or addressed to another fingerprint. It applies each job id at most once and remembers recent ids across factory resets.

### Job kinds

| Kind | Effect on the device |
|------|---------------------|
| `credential.set`, `credential.rotate` | Stores the new password |
| `firmware.offer` | Passes `{ releaseUri, imageSha256, version?, cid? }` to the application's `onFirmwareOffer` callback, which is expected to download and verify the release with `@open-firmware/client`. With no callback configured the job is acknowledged as `unsupported`, never `ok`. |
| `firmware.apply` | Always rejected, by server and device. Firmware bytes never travel through the control plane. |
| anything else | Acknowledged as `unsupported` |

`ofw-util` has commands for joins, devices, `set-password`, `list-jobs` and `control-key`. Sending a firmware offer is available as a library call (`OpenFirmwareUtility.offerFirmware`) but has no command yet, and no default offer handler ships with the device agent.

### HTTP API

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /healthz` | none | Liveness |
| `GET /v1/meta` | none | Job-signing public key and record counts |
| `POST /v1/join` | device signature in body | Request enrollment |
| `GET /v1/devices/by-fingerprint/{fp}` | none | Enrollment status and the job-signing public key |
| `GET /v1/join-requests?status=` | admin | List joins (`pending` by default, or `all`) |
| `POST /v1/join-requests/{id}/approve` · `/deny` | admin | Decide a pending join |
| `GET /v1/devices` | admin | List enrollments |
| `POST /v1/jobs` | admin | Create a sealed, signed job |
| `GET /v1/jobs` | admin | List jobs (without ciphertext) |
| `GET /v1/devices/me/jobs` | device | Pull pending jobs |
| `POST /v1/jobs/{id}/ack` | device | Report `ok`, `failed` or `unsupported` |

Admin routes take `Authorization: Bearer <token>`. Device routes take `x-ofw-fingerprint`, `x-ofw-timestamp`, `x-ofw-nonce` and `x-ofw-signature`, where the signature covers `"{METHOD} {path}|{fingerprint}|{timestamp}|{nonce}"` (plus `|{status}` on an ack). The timestamp must be within the allowed skew, the enrollment must be active, and a nonce is accepted once.

Server configuration is in [production.md](./production.md#control-plane-server-appsserver); the limits of this design (no TLS, trust on first use, in-memory nonce cache, self-asserted serial, no revocation) are in [SECURITY.md](../SECURITY.md#known-weaknesses).
