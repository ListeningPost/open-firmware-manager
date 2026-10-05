# Changelog

Notable changes to Open Firmware. The project is pre-1.0; nothing has been tagged or released yet.

## Unreleased (0.1.0, early prototype)

### Update trust chain

- OEM signatures fail closed: with pinned keys an unsigned or wrongly signed release is refused, and the key embedded in a record counts only if it is pinned.
- Pipeline acks are bound to the release CID as well as its URI.
- Consumers can set a minimum pipeline policy and their own stage list; `OFW_ATTESTER_DIDS` on Sidekar requires attester acks whatever the release declares.
- The client checks that the channel pointer and release name the requested product and channel, keeps the CID pin through download, and treats an unreadable gate as a failure.
- Releases are create-only in both publishers.
- Blob downloads and image sizes are capped; invalid byte counts are rejected in the metadata audit.
- Sidekar refuses unknown artifact kinds instead of treating them as packages.

### Control plane

- The server signs every job with an Ed25519 key; devices pin the key (at the factory, or on first enrollment) and refuse unsigned or forged jobs.
- Device requests carry a single-use nonce in addition to a timestamp.
- Devices keep a job replay record that survives factory reset.
- `firmware.offer` is handed to an application callback and acknowledged as `unsupported` when none is configured, instead of being reported as applied.
- `OFW_ADMIN_TOKEN` always overrides the stored token; the token is no longer logged by default.
- Join requests are validated, capped and expire; request bodies are size-limited; CORS is off unless configured.
- `ofw-util control-key` prints the server's job-signing public key.

### `ofw` CLI (Rust)

- Ed25519 OEM signing at publish (`--oem-key`), verified by `ofw audit` against pinned keys.
- Promotion refuses failed gates and rewritten releases, flags self-attestation, and will not move a channel to an older version without `--allow-downgrade`.
- `--password-stdin`; plain HTTP refused for non-loopback hosts unless `--allow-insecure-http`.
- End-to-end tests against a mock PDS and a signature interop test with the TypeScript implementation.

### Build and CI

- ESLint and Prettier; root `build`, `test`, `lint`, `typecheck` scripts.
- CI workflow (TypeScript on Node 20 and 22, Rust, Docker builds, advisory dependency audit) and a tag-driven release workflow with checksums and build provenance. npm publishing is disabled by default. Neither workflow has run on GitHub yet.
- Dockerfiles use a frozen lockfile, digest-pinned base images and a non-root user.

### Documentation

- README, SECURITY.md and `docs/` rewritten to describe what is implemented, with limitations and roadmap listed separately.
