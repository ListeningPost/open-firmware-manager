# `@open-firmware/sidekar`

Production **server-side** agent.

- Polls an AT Protocol **PDS** for ready releases
- Phase A/B via `@open-firmware/client` + `@open-firmware/core`
- Applies `package` (file write), `container` (`docker load`), `deployment` (compose)

```bash
PDS_URL=https://pds.example.com \
AUTHOR_DID=did:plc:… \
PRODUCT=my-app \
PACKAGE_TARGET=/data/app.bin \
node dist/cli.js
```
