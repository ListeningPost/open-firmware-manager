#!/usr/bin/env bash
# The happy path, end to end, with every trust check switched on:
#
#   1. publisher   ofw publish, OEM-signed (Ed25519), CI gate required
#   2. CI          independent account attests build + test
#   3. publisher   ofw pipeline-promote, counting only the CI account's acks
#   4. Sidekar     verifies OEM signature, CI acks and SHA-256, then applies
#   5. anyone      ofw audit
#
#   ./scripts/demo-happy-path.sh ["message for the demo site"]
#   DEMO_PAUSE=1 ./scripts/demo-happy-path.sh "…"   # wait for Enter between steps
#   VERSION=2.0.0 ./scripts/demo-happy-path.sh "…"  # pick the version yourself
#   NO_PROMOTE=1 …                                  # stop after step 1 (see promote.sh)
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_stack

MSG="${1:-Hello from an OEM-signed, CI-attested release}"
VERSION="${VERSION:-$(pds next-version "$PUBLISHER_DID" "$PRODUCT")}"
RKEY="$(release_rkey "$VERSION")"
STAGES="build,test"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf '%s' "$MSG" >"${TMP}/payload.txt"
T0=$SECONDS
SINCE="$(now_utc)"

step "1/5  Publisher signs with the OEM key and publishes ${PRODUCT} ${VERSION} (CI gate required)"
say "payload: \"${MSG}\""
pause
show "ofw publish --product ${PRODUCT} --version ${VERSION} --kind package --file payload.txt \\"
show "      --require-pipeline --stages ${STAGES} --oem-key .local/oem.pem --oem-key-id ${OEM_KEY_ID} --yes"
"$OFW" publish --product "$PRODUCT" --version "$VERSION" --channel "$CHANNEL" --kind package \
  --file "${TMP}/payload.txt" --require-pipeline --stages "$STAGES" \
  --oem-key "$OEM_KEY_FILE" --oem-key-id "$OEM_KEY_ID" --yes 2>&1 | grep -v '^  Next:' | sed 's/^/   /'
good "published. gate = $(pds gate "$PUBLISHER_DID" "$RKEY"); the channel has NOT moved, so no device sees it yet."

if [[ "${NO_PROMOTE:-0}" == "1" ]]; then
  say "stopping here (NO_PROMOTE=1). Next: ./scripts/promote.sh ${VERSION}"
  exit 0
fi

step "2/5  Independent CI (${CI_HANDLE}) runs build + test and attests the result"
say "the CI account has no publisher credentials; its acks name this exact release CID"
pause
pds wait-acks "$PUBLISHER_DID" "$RKEY" "$CI_DID" "$STAGES" 60
good "CI attested ${STAGES}."

step "3/5  Publisher promotes — ofw counts only acks written by the CI account"
pause
show "ofw pipeline-promote --rkey ${RKEY} --attester-did ${CI_DID}"
"$OFW" pipeline-promote --rkey "$RKEY" --attester-did "$CI_DID" 2>&1 | sed 's/^/   /'
good "gate = $(pds gate "$PUBLISHER_DID" "$RKEY"); channel ${PRODUCT}/${CHANNEL} -> $(pds live-version "$PUBLISHER_DID" "$PRODUCT" "$CHANNEL")"

step "4/5  Sidekar re-checks everything itself, then applies"
say "pinned OEM key, CI attester's acks, publisher DID, per-part and whole-image SHA-256"
pause
if ! wait_until 30 site_shows "$MSG"; then
  sidekar_log "$SINCE" | sed 's/^/   sidekar | /'
  die "Sidekar did not apply ${VERSION} within 30s. docker compose logs --tail 30 sidekar"
fi
sidekar_log "$SINCE" | sed 's/^/   sidekar | /'
good "demo site (${DEMO_SITE_URL/127.0.0.1/localhost}) now says: \"$(site_message)\""

step "5/5  Anyone can audit the release — no credentials needed"
pause
show "ofw audit --repo ${PUBLISHER_HANDLE} --rkey ${RKEY} --probe-blobs --trusted-oem-key ${OEM_PUBLIC_KEY}"
env -u OFW_IDENTIFIER -u OFW_PASSWORD "$OFW" audit --repo "$PUBLISHER_HANDLE" --rkey "$RKEY" \
  --probe-blobs --trusted-oem-key "$OEM_PUBLIC_KEY" 2>&1 | sed 's/^/   /'

printf '\n%sDONE%s  %s %s is live (%ss).\n' "$C_GREEN" "$C_OFF" "$PRODUCT" "$VERSION" "$((SECONDS - T0))"
