# Synthetic camera emulator

Proves factory identity, admin join/approve, sealed password jobs, synthetic firmware apply, and deterministic factory reset.

```bash
# from monorepo root (builds deps via workspace)
pnpm --filter @open-firmware/iot build
pnpm --filter @open-firmware/utility build
pnpm --filter @open-firmware/server build
pnpm --filter @open-firmware/iot-camera-emulator test:e2e
```

## Manual loop

Terminal A — control plane:

```bash
OFW_ADMIN_TOKEN=local-dev-admin-token DATA_FILE=/tmp/ofw-ctrl.json \
  node apps/server/dist/index.js
```

Terminal B — camera:

```bash
OFW_CONTROL_URL=http://127.0.0.1:8787 node examples/iot-camera-emulator/src/run.mjs init
OFW_CONTROL_URL=http://127.0.0.1:8787 node examples/iot-camera-emulator/src/run.mjs run
```

Terminal C — admin:

```bash
export OFW_CONTROL_URL=http://127.0.0.1:8787
export OFW_ADMIN_TOKEN=local-dev-admin-token
node packages/utility/dist/cli.js list-pending
node packages/utility/dist/cli.js approve <joinId>
node packages/utility/dist/cli.js set-password <fingerprint> 'new-secret'
```
