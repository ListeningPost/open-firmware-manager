# Factory provisioning & reset

Each IoT unit gets a **factory profile** that survives reset:

- Device keypairs (Ed25519 identity, X25519 sealing)  
- Fingerprint + human mnemonic  
- Per-serial default password (`KDF(factorySecret, serial)`)  
- Control plane URL hint  

**Factory reset** wipes user data, restores defaults, keeps identity, and auto-requests join again.

## Emulator

```bash
cd examples/iot-camera-emulator
# with control plane running on :8787
pnpm --filter @open-firmware/iot-camera-emulator test:e2e

# interactive
node src/run.mjs init
node src/run.mjs run
# elsewhere: ofw-util approve …
node src/run.mjs factory-reset
```
