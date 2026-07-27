# Open Firmware

Production system for **cryptographically signed software distribution** over **AT Protocol**.

The **distribution center is a PDS**. Publishers write signed release chains (records + blobs). Edge agents and Sidekar pull, audit, and apply.

## Products

| Package | Role | Docker? |
|---------|------|---------|
| `@open-firmware/core` | Chunking, Phase A audit, service windows | No |
| `@open-firmware/atproto-lite` | Vanilla XRPC client | No |
| `@open-firmware/host` | Publish releases to PDS | No |
| `@open-firmware/client` | IoT/edge pull + verify + apply hooks | **No** |
| `@open-firmware/sidekar` | Server agent; optional Docker apply | Optional |
| `@open-firmware/iot` | Device identity, factory reset, sealed jobs | No |
| `@open-firmware/utility` | Admin: approve join, set password, jobs | No |
| `@open-firmware/server` | Private control plane API | No |
| `ofw` (Rust CLI) | `release` / `publish` / `pipeline-ack` / `audit` | No |

## Trust model

1. Author **DID + PDS commit signatures** authenticate records  
2. Content digests (SHA-256) on release + chunks  
3. **Phase A** validates the full chain before download  
4. **Phase B** verifies blobs and full-image hash before apply  

AppViews and dashboards are never the trust root.

## Quick start (guided walkthrough)

```bash
cd examples/full-stack
./scripts/gen-pds-secrets.sh
docker compose up --build -d

# Guided UI (plain language + live status):
#   http://localhost:8099
# Full written tour:
#   examples/full-stack/WALKTHROUGH.md

./scripts/publish-to-pds.sh "Hello from Open Firmware"
# Workload: http://localhost:8080
# PDS:      http://127.0.0.1:2583/xrpc/_health
```

## Production publish

```bash
cd cli && cargo install --path .

ofw publish \
  --pds https://your-pds.example \
  --identifier your-handle \
  --password "$OFW_PASSWORD" \
  --product my-app \
  --version 1.0.0 \
  --kind container \
  --file ./image.tar \
  --yes
```

GitHub Actions: `cli/examples/github-actions-publish.yml`.

## IoT management (join / password / factory reset)

```bash
pnpm --filter @open-firmware/iot build
pnpm --filter @open-firmware/utility build
pnpm --filter @open-firmware/server build
pnpm --filter @open-firmware/iot-camera-emulator test:e2e
```

See [examples/iot-camera-emulator](./examples/iot-camera-emulator) and [docs/private-plane.md](./docs/private-plane.md).

## Specs & docs

- [docs/spec-release-chain.md](./docs/spec-release-chain.md)  
- [docs/architecture.md](./docs/architecture.md)  
- [docs/private-plane.md](./docs/private-plane.md)  
- [docs/factory-provisioning.md](./docs/factory-provisioning.md)  
- [docs/sidekar.md](./docs/sidekar.md)  
- [SECURITY.md](./SECURITY.md)  

## Develop

```bash
pnpm install
pnpm --filter @open-firmware/core test
pnpm --filter @open-firmware/iot test
pnpm -r run build
cd cli && cargo test && cargo build --release
```

## License

Apache-2.0
