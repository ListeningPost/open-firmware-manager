#!/usr/bin/env bash
# One-shot generic CI runner (NOT Sidekar): ack build+test for awaiting_pipeline releases.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "${ROOT}/../.." && pwd)"

export PDS_URL="${PDS_URL:-http://127.0.0.1:2583}"
export HOST_PDS_URL="${HOST_PDS_URL:-http://127.0.0.1:2583}"
export OFW_IDENTIFIER="${OFW_IDENTIFIER:-publisher.pds.test}"
export OFW_PASSWORD="${OFW_PASSWORD:-publisher-pass-change-me}"
export ONCE=1
export AUTO_ACK=1
export STAGES="${STAGES:-build,test}"

# Prefer DID from docker volume via curl if compose is up
if docker compose -f "${ROOT}/docker-compose.yml" ps -q bootstrap >/dev/null 2>&1; then
  DID=$(docker compose -f "${ROOT}/docker-compose.yml" run --rm --no-deps \
    -v open-firmware-example_publisher-config:/config alpine \
    cat /config/author.did 2>/dev/null | tr -d '\r\n' || true)
  if [[ -n "${DID:-}" ]]; then
    export AUTHOR_DID="$DID"
  fi
fi

# Fallback: resolve via createSession
if [[ -z "${AUTHOR_DID:-}" ]]; then
  AUTHOR_DID=$(curl -fsS -X POST "${PDS_URL}/xrpc/com.atproto.server.createSession" \
    -H 'content-type: application/json' \
    -d "{\"identifier\":\"${OFW_IDENTIFIER}\",\"password\":\"${OFW_PASSWORD}\"}" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).did))")
  export AUTHOR_DID
fi

export OFW_BIN="${REPO}/cli/target/release/ofw"
if [[ ! -x "$OFW_BIN" ]]; then
  (cd "${REPO}/cli" && cargo build --release)
fi

echo "pipeline-runner-once AUTHOR_DID=${AUTHOR_DID}"
node "${ROOT}/services/pipeline-runner/runner.mjs"
