#!/usr/bin/env bash
# Start the whole demo stack and wait until every service is healthy.
#   ./scripts/demo-up.sh             build images if needed, then start
#   ./scripts/demo-up.sh --no-build  start from the images already built (offline)
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
need_tools docker node curl openssl

BUILD=(--build)
[[ "${1:-}" == "--no-build" ]] && BUILD=()

"${ROOT}/scripts/demo-setup.sh" >/dev/null
ensure_ofw

START=$SECONDS
echo "starting the stack (waits for health checks)…"
if ! compose up -d "${BUILD[@]}" --wait --wait-timeout 180; then
  compose ps -a >&2 || true
  die "the stack did not become healthy. Look at: docker compose logs --tail 50
If it mentions EACCES or 'permission denied', old volumes are in the way: ./scripts/demo-reset.sh"
fi

# compose --wait returns when containers are healthy; make sure the accounts exist too.
wait_until 30 pds did "$PUBLISHER_HANDLE" || die "publisher account missing: docker compose logs bootstrap"
wait_until 30 pds did "$CI_HANDLE" || die "CI attester account missing: docker compose logs bootstrap"

echo
echo "${C_GREEN}stack is up${C_OFF} ($((SECONDS - START))s)"
echo "  publisher        ${PUBLISHER_HANDLE}  $(pds did "$PUBLISHER_HANDLE")"
echo "  CI attester      ${CI_HANDLE}         $(pds did "$CI_HANDLE")"
echo "  OEM public key   $(oem_public_key "$OEM_KEY_FILE")  (private key: ${OEM_KEY_FILE#"$REPO"/})"
echo
echo "  walkthrough UI   http://localhost:8099"
echo "  demo site        http://localhost:8080"
echo "  PDS              http://localhost:2583/xrpc/_health"
echo "  control plane    http://localhost:8787/v1/meta"
echo
echo "next: ./scripts/demo-happy-path.sh \"Hello, investors\""
