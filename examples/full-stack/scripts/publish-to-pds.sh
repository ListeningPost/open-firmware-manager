#!/usr/bin/env bash
# Publish a message/package to the local AT Protocol PDS using ofw.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "${ROOT}/../.." && pwd)"
OFW="${REPO}/cli/target/release/ofw"

if [[ ! -x "$OFW" ]]; then
  (cd "${REPO}/cli" && cargo build --release)
fi

# Prefer credentials from bootstrap volume dump if present on host
if [[ -f "${ROOT}/.local/publisher.env" ]]; then
  # shellcheck disable=SC1091
  source "${ROOT}/.local/publisher.env"
fi

# Defaults match bootstrap
export OFW_PDS="${OFW_PDS:-http://127.0.0.1:2583}"
export OFW_IDENTIFIER="${OFW_IDENTIFIER:-publisher.pds.test}"
export OFW_PASSWORD="${OFW_PASSWORD:-publisher-pass-change-me}"

MSG="${1:-Hello from the real AT Protocol PDS}"
VERSION="${VERSION:-}"
if [[ -z "$VERSION" ]]; then
  # Monotonic: full epoch seconds (short tails wrap and Sidekar skips "older" versions).
  VERSION="1.$(date +%s).0"
fi

TMP="$(mktemp)"
printf '%s' "$MSG" >"$TMP"

echo "Publishing to PDS ${OFW_PDS} as ${OFW_IDENTIFIER}"
echo "  product=demo-site version=${VERSION}"
echo "  message=${MSG}"

# Default: skip pipeline (ready immediately). Use publish-with-pipeline.sh for CI gate.
"$OFW" publish \
  --pds "$OFW_PDS" \
  --identifier "$OFW_IDENTIFIER" \
  --password "$OFW_PASSWORD" \
  --product demo-site \
  --version "$VERSION" \
  --channel stable \
  --kind package \
  --file "$TMP" \
  --skip-pipeline \
  --yes \
  --json

rm -f "$TMP"
echo
echo "Pipeline skipped → status ready. Sidekar will update http://localhost:8080 shortly."
echo "For CI-gated publish: ./scripts/publish-with-pipeline.sh \"msg\""
