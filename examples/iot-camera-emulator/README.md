# Synthetic camera emulator

Proves factory identity, admin join/approve, sealed password jobs signed by the control plane (forged jobs are refused), `firmware.offer` hand-off to the application, and deterministic factory reset.

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
OFW_CONTROL_URL=http://127.0.0.1:8787 OFW_FACTORY_SECRET=local-dev-secret \
  node examples/iot-camera-emulator/src/run.mjs init
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

`init` pins the control plane's job-signing key into the factory profile (read
from `GET /v1/meta`, or from `OFW_CONTROL_PUBLIC_KEY` — print it with
`node packages/utility/dist/cli.js control-key`). The device then applies only
jobs signed by that key. Without `OFW_FACTORY_SECRET` the insecure development
default is used and a warning is printed.

The emulator wires no `onFirmwareOffer` handler, so a `firmware.offer` job is
acknowledged as `unsupported` rather than `ok`.
