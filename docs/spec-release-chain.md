# Release chain specification

The contract between **publishers** (the Rust `ofw` CLI and the TypeScript `@open-firmware/host` library) and **consumers** (`@open-firmware/client`, Sidekar, and `ofw audit`). It describes the behaviour implemented on this branch; the format is pre-1.0 and may change.

The distribution center is an AT Protocol PDS. Releases are repository records and blobs in the **author's** account.

## Layers of assurance

1. **Content addressing.** The release record lists every part with its length, SHA-256 and blob CID, and the SHA-256 and size of the whole image. The channel pointer and gate name the release by URI and CID. Consumers pin the CID and recompute every digest.
2. **OEM signature (optional, enforceable).** A detached Ed25519 signature over `v1|{product}|{version}|{channel}|{imageSha256}|{imageSize}`, verified against keys pinned on the consumer. Independent of the PDS account.
3. **AT Protocol repository signatures: not verified yet.** Consumers currently trust the records returned by the PDS they are configured with. Verifying the author's DID document and signed commits is planned. Until then, layer 2 is what protects image content against a compromised PDS or publisher password. See [SECURITY.md](../SECURITY.md).

An AppView is an untrusted index and is not part of the chain.

## Collections

| NSID | Record key | Role |
|------|-----------|------|
| `app.openfirmware.firmware.release` | `{product}-{version}-{channel}` | Immutable manifest with `parts[]` blobs. Create-only. |
| `app.openfirmware.firmware.gate` | same key as the release | Mutable state: `awaiting-pipeline`, `ready` or `failed`, with a strong reference (URI + CID) to the release. |
| `app.openfirmware.firmware.channel` | `{product}-{channel}` | Mutable pointer to the current ready release (URI + CID), with `product`, `channel`, `version`, `updatedAt`. |
| `app.openfirmware.firmware.pipelineAck` | TID | One CI stage result, with a strong reference to the release. Stored in the repository of whoever wrote it. |
| `app.openfirmware.firmware.releaseSeal` | TID | Optional summary written by `@open-firmware/host`; not read by consumers. |
| `app.openfirmware.actor.declaration` | `self` | Lists the publisher's products, for discovery. |

Record keys replace any character outside `[A-Za-z0-9._~-]` with `-`. Because that is lossy, consumers check the `product` and `channel` fields inside the records rather than trusting the key. Product and version must match `[A-Za-z0-9][A-Za-z0-9._+~-]*` (at most 128 characters); consumers refuse other values because they become file names.

## Publish order

1. Read the artifact; compute `imageSha256` and `imageSize`.
2. Split into parts of `chunkSize` (default 4 MiB; at most 50 MiB per part; `ofw` allows at most 512 parts).
3. `uploadBlob` each part.
4. `createRecord` the release once, with `parts[]` complete and, if a key was given, `oemSignature`. If the key already exists the publish fails: a release is never overwritten, so acks and gates issued for one set of bytes cannot come to vouch for another.
5. Write the gate (`awaiting-pipeline` or `ready`) with compare-and-swap.
6. If the gate is `ready`, write the channel pointer with compare-and-swap. `ofw` first checks that this does not move the channel to an older version (override: `--allow-downgrade`).

Without `--require-pipeline` (the default) a release is `ready` immediately:

```
ofw publish ...                                        → gate=ready, channel moved
ofw publish ... --require-pipeline --stages build,test → gate=awaiting-pipeline, channel not moved
```

## Promotion

A release published with `--require-pipeline` reaches `ready` only when the **publisher account** promotes it. Acks on their own never change the gate unless the publisher account wrote them. The rules, as implemented by `ofw`:

- An ack counts if it names the release's URI and CID and is stored in the repository of an accepted attester. The attester is identified by the repository the ack lives in, not by the ack's self-declared `actor` field. Per stage, the newest ack wins.
- `ofw pipeline-promote --attester-did <did>` promotes when every required stage has a counting `passed` or `skipped` ack. It writes nothing and exits non-zero while a stage is missing, if the newest ack of a required stage is `failed`, if the gate is `failed`, or if the release record's CID differs from the one the gate was created for.
- **Self-attestation.** Without `--attester-did` (or when the only attester named is the publisher), only the publisher's own acks are counted. `ofw` warns, reports `"selfAttested": true`, and records `promoted on self-attested acks` in the gate's `reason`.
- **Auto-promotion.** When the publisher account itself runs `ofw pipeline-ack` with `passed` or `skipped`, `ofw` runs the same check and promotes if it is satisfied (`--no-promote` disables this). An ack written by any other account never touches the gate.
- **Failure.** A `failed` ack written by the publisher account sets the gate to `failed`. A failed gate is not promoted by later acks; publish a new version.
- **Override.** `ofw pipeline-skip` sets the gate to `ready` and moves the channel regardless of acks. It still refuses a release whose CID no longer matches the gate, needs `--override-failed` for a failed gate, and needs `--allow-downgrade` to move the channel backwards.
- **Downgrade guard.** Every channel move by `ofw` compares the new version with the one the pointer names now and refuses an older or incomparable one without `--allow-downgrade`.

`@open-firmware/host` (TypeScript) implements create-only releases, CID-bound acks, attester filtering and auto-promotion, but **not** the downgrade guard, the failed-gate refusal or the self-attestation marker. Use `ofw` for promotion where those matter.

## Consumer rules

### Resolve

1. `getRecord` the channel pointer for the wanted product and channel. Missing pointer: nothing to install. Its `product` and `channel` fields must match the request.
2. The release DID (from the pointer's `at://` URI) must be in `trustedAuthors`, and the collection must be the release collection.
3. `getRecord` the release with the pointer's CID. The returned URI and CID must match; `product`, `version` and `kind` must be well formed; `product` and `channel` must match the request.
4. `getRecord` the gate. If present it must reference the same release URI and CID. If it cannot be read for any reason other than "no such record", stop. With no gate record, a release reached through the channel pointer is treated as `ready`; a release addressed directly by URI is treated as `awaiting-pipeline`.
5. Collect acks for that URI and CID from the author's repository and from each configured attester's repository, then evaluate the pipeline policy:
   - policy comes from the release (`pipelinePolicy`, or `strict` if `requirePipelineAcks`); an unrecognised value is treated as `strict`;
   - the consumer can set a minimum policy and its own stage list; the release can raise the policy but not lower it;
   - setting `attesterDids` makes the minimum `strict` and counts only acks from those DIDs;
   - under `strict`, every required stage (default `build`, `test`) needs a newest ack of `passed` or `skipped`.
6. The release is installable only if the gate is `ready` and the pipeline check passes.

### Phase A: metadata audit, before any download

Fails closed on: wrong `$type`; gate not `ready`; malformed image or part digests; author mismatch; invalid sizes; part count, sequence gaps or duplicates; offsets that are not contiguous; part lengths that do not sum to `imageSize`; blob size differing from part length; image larger than the consumer's cap (default 1 GiB); insufficient free space when the caller supplies it; and the OEM signature when required.

OEM signature policy: if the consumer has pinned keys, an unsigned release fails (`OEM_SIG_MISSING`) and a signature that is invalid or from an unpinned key fails (`OEM_SIG_INVALID`). If a signature is required but no keys are pinned, every release fails. With no keys and no requirement, the signature is ignored.

### Phase B: download and verify

1. `com.atproto.sync.getBlob` each part, refusing to read more than the part's declared length.
2. Check the length, the SHA-256, and the blob CID (CIDv1, raw codec, sha2-256).
3. Assemble in order; check `imageSize` and `imageSha256`.
4. Hand the file to the apply handler for its `kind`.

### Version order

`pullIfNewer` applies a release only if its version is strictly greater (semver) than the currently applied one.

## OEM signature format

`oemSignature` is `{ alg: "ed25519", publicKey, sig, keyId? }`, with the raw 32-byte public key and 64-byte signature in unpadded base64url. The signed message is exactly

```
v1|{product}|{version}|{channel}|{imageSha256 in lowercase hex}|{imageSize in decimal}
```

It binds the bytes to a product, version and channel. It does not cover `kind`, the part layout, pipeline fields, or the record's CID; [SECURITY.md](../SECURITY.md#what-the-oem-signature-binds) spells out the consequences. The Rust and TypeScript implementations are cross-checked by `cli/tests/ts_interop.rs`.
