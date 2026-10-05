# Factory provisioning and reset

Implemented in `@open-firmware/iot` (`initFactoryProfile`, `factoryReset`). The device's storage is split into two directories:

| Directory | Survives factory reset | Contents |
|-----------|------------------------|----------|
| `factory/` | Yes | `profile.json` (below) and `job-guard.json`, the record of control-plane jobs already handled |
| `user-data/` | No | `state.json` (enrollment, current password, firmware version, a control key pinned at enrollment) and the staged firmware image |

Files are written with mode `0600` and directories with `0700`. Keys are ordinary files; there is no secure-element support yet.

## The factory profile

- Product and serial number
- An Ed25519 identity key pair and an X25519 encryption key pair, generated on the device
- Fingerprint: `sha256(product|ed25519PublicKey)`, and a six-word mnemonic derived from it for humans to compare
- Default password: the first 16 hex characters of `sha256(factorySecret|serial|ofw-factory)`. The fleet-wide factory secret is used once to derive this and is not stored on the device.
- Control plane URL (default `http://127.0.0.1:8787`)
- Optionally, the control plane's job-signing public key (`controlPublicKey`). Print it with `ofw-util control-key` or read it from `GET /v1/meta`.

Provision `controlPublicKey` at the factory. If it is absent the device pins whichever key the control endpoint presents the first time it sees itself enrolled (trust on first use), and that pin is in `user-data/`, so it is forgotten on reset.

If no `factorySecret` is passed, a public development constant is used and a warning is printed: default passwords are then computable by anyone who knows the serial.

## Factory reset

`factoryReset` deletes `user-data/` and recreates the initial state: not enrolled, password back to the factory default, firmware version `0.0.0`, status `awaiting_enrollment`. The identity keys, fingerprint and mnemonic are unchanged, and so is the job replay record, so jobs captured before the reset cannot be replayed after it.

Reset does **not** contact the control plane. The application must call `requestJoin()` again afterwards (the emulator's `run` command does this on start). Note also that the control plane has no revocation yet: it keeps the previous enrollment for the fingerprint, so a reset device that polls its status is reported as enrolled without a new approval. If the device is changing hands, that enrollment has to be removed from the server's store by other means for now.

## Trying it with the emulator

`examples/iot-camera-emulator` is a simulated camera. The automated run starts everything it needs:

```bash
pnpm -r build
pnpm test:e2e
```

It starts its own control plane on a local port and checks join, approval, a signed password job, rejection of forged jobs, the firmware-offer hand-off, and factory reset followed by re-join.

For the manual three-terminal loop (control plane, camera, admin) see [examples/iot-camera-emulator/README.md](../examples/iot-camera-emulator/README.md).
