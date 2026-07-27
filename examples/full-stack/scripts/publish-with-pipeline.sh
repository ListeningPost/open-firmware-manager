#!/usr/bin/env bash
# Publish a package that REQUIRES CI/pipeline acks before Sidekar will install.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "${ROOT}/../.." && pwd)"
OFW="${REPO}/cli/target/release/ofw"

if [[ ! -x "$OFW" ]]; then
  (cd "${REPO}/cli" && cargo build --release)
fi

export OFW_PDS="${OFW_PDS:-http://127.0.0.1:2583}"
export OFW_IDENTIFIER="${OFW_IDENTIFIER:-publisher.pds.test}"
export OFW_PASSWORD="${OFW_PASSWORD:-publisher-pass-change-me}"

MSG="${1:-Hello after pipeline tests}"
VERSION="${VERSION:-1.$(date +%s).0}"
TMP="$(mktemp)"
printf '%s' "$MSG" >"$TMP"

echo "Publishing WITH pipeline gate → awaiting_pipeline"
echo "  product=demo-site version=${VERSION}"
echo "  message=${MSG}"

"$OFW" publish \
  --pds "$OFW_PDS" \
  --identifier "$OFW_IDENTIFIER" \
  --password "$OFW_PASSWORD" \
  --product demo-site \
  --version "$VERSION" \
  --channel stable \
  --kind package \
  --file "$TMP" \
  --require-pipeline \
  --stages build,test \
  --yes \
  --json

rm -f "$TMP"
echo
echo "Release is awaiting_pipeline."
echo "  • Watch http://localhost:8099 for stage results"
echo "  • Runner will auto-ack if pipeline-runner is up, or run:"
echo "      ./scripts/pipeline-runner-once.sh"
echo "  • Sidekar installs only after status becomes ready"
