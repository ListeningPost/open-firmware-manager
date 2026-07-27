# Full-stack example

**Start here:** the [**guided walkthrough**](./WALKTHROUGH.md).

```bash
./scripts/gen-pds-secrets.sh
docker compose up --build -d
# Guided UI:
open http://localhost:8099
# Publish an update:
./scripts/publish-to-pds.sh "Hello walkthrough"
# See the app change:
open http://localhost:8080
```

## Services

| Service | Port | Role |
|---------|------|------|
| **walkthrough** | **8099** | Tour + live releases/CI stage results |
| **demo-site** | **8080** | Example app updated by Sidekar |
| **pds** | **2583** | AT Protocol distribution center |
| **pipeline-runner** | — | Generic CI validator (acks build/test) — **not** Sidekar |
| **sidekar** | — | Installs **ready** releases only |
| **control** | **8787** | Join approve + sealed jobs |
| **bootstrap** | — | Creates example publisher account |

## Credentials (local example only)

| Field | Value |
|-------|--------|
| Handle | `publisher.pds.test` |
| Password | `publisher-pass-change-me` |
| PDS | `http://127.0.0.1:2583` |

Do **not** use these in production.

## Tear down

```bash
docker compose down -v
```
