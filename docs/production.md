# Production deployment

## Roles

| Component | Runs where | Responsibility |
|-----------|------------|----------------|
| **PDS** | Your infra (or hosted AT PDS) | Source of truth: signed records + blobs |
| **`ofw` / `@open-firmware/host`** | CI or operator laptop | Publish releases |
| **`@open-firmware/sidekar`** | Each server host | Poll PDS, verify, apply packages/containers |
| **`@open-firmware/client`** | IoT / edge agents | Same pull path **without** Docker |

## Minimum production checklist

1. **PDS** with TLS, strong admin password, app passwords for publisher DID  
2. **Publisher identity** (DID) reserved for releases; document `trustedAuthors` on every Sidekar  
3. **CI** runs `ofw publish --yes` with secrets (never commit passwords)  
4. **Sidekar** as a supervised process/container with:
   - `PDS_URL`, `AUTHOR_DID`, `PRODUCT`, `CHANNEL`
   - For containers: Docker socket or remote API + `DOCKER_LOAD=1`
5. **Phase A always on** — never skip audit  
6. **Monitoring**: Sidekar state file / logs; optional fleet status records later  

## Environment variables (Sidekar)

| Variable | Description |
|----------|-------------|
| `PDS_URL` | PDS base URL |
| `AUTHOR_DID` | Release author DID |
| `PRODUCT` | Product id to track |
| `CHANNEL` | `stable` / `beta` / `dev` |
| `POLL_MS` | Poll interval (default 15000) |
| `PACKAGE_TARGET` | Path for package-kind payload |
| `DOCKER_LOAD` | `1` to `docker load` container tars |
| `COMPOSE_PROJECT_DIR` | Optional compose project to recreate after load |

## Not production

- Local `pds.test` handles and `publisher-pass-change-me` in the example stack  
- Example `demo-site` UI workload  
- Committing `pds.secrets.env`  

These exist only under `examples/full-stack` to exercise the real protocol path.
