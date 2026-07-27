#!/usr/bin/env bash
# Generate stable local PDS secrets (once). Safe for demo only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/pds.secrets.env"

if [[ -f "$OUT" ]]; then
  echo "exists: $OUT (not overwriting)"
  exit 0
fi

{
  echo "PDS_JWT_SECRET=$(openssl rand -hex 16)"
  echo "PDS_ADMIN_PASSWORD=admin-ofw-demo"
  echo "PDS_DPOP_SECRET=$(openssl rand -hex 32)"
  echo "PDS_REPO_SIGNING_KEY_K256_PRIVATE_KEY_HEX=$(openssl rand -hex 32)"
  echo "PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=$(openssl rand -hex 32)"
} >"$OUT"

chmod 600 "$OUT"
echo "wrote $OUT"
