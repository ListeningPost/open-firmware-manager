#!/usr/bin/env bash
# ATTACK 3 — replace a release that is already live.
#
# Releases are immutable. The attacker (stolen publisher password) tries to
# swap the bytes behind the version that devices already trust:
#
#   a) with ofw: publishing the same product/version/channel again is refused;
#   b) without ofw: rewriting the release record in place through the raw PDS
#      API. The PDS allows it (it is the publisher's own repo), but the record
#      gets a new content ID. The channel pointer, the gate and the CI acks
#      all name the OLD content ID, so Sidekar and `ofw audit` both refuse it.
#
#   ./scripts/attack-overwrite.sh
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_stack

VERSION="$(pds live-version "$PUBLISHER_DID" "$PRODUCT" "$CHANNEL")"
[[ -n "$VERSION" ]] || die "nothing is live yet. Run ./scripts/demo-happy-path.sh first."
RKEY="$(release_rkey "$VERSION")"
# The target must be a good release that Sidekar accepted, not the leftover of
# an earlier attack beat.
env -u OFW_IDENTIFIER -u OFW_PASSWORD "$OFW" audit --repo "$PUBLISHER_HANDLE" --rkey "$RKEY" \
  --trusted-oem-key "$OEM_PUBLIC_KEY" >/dev/null 2>&1 ||
  die "the channel points at ${VERSION}, which is not a good release (left by an earlier attack?). Run ./scripts/demo-happy-path.sh first."
BEFORE="$(site_message)"
PAYLOAD="PWNED: same version number, different bytes"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf '%s' "$PAYLOAD" >"${TMP}/payload.txt"
SINCE="$(now_utc)"

attack_banner "replace the bytes behind the live release ${PRODUCT} ${VERSION}" \
  "demo site currently says: \"${BEFORE}\""
pause

step "a) Publish ${VERSION} again with different bytes"
show "ofw publish --product ${PRODUCT} --version ${VERSION} --kind package --file evil.txt --skip-pipeline --yes"
rc=0
"$OFW" publish --product "$PRODUCT" --version "$VERSION" --channel "$CHANNEL" --kind package \
  --file "${TMP}/payload.txt" --skip-pipeline --yes 2>&1 | sed 's/^/   /' || rc=${PIPESTATUS[0]}
if [[ $rc -eq 0 ]]; then
  bad "FAILED OPEN: ofw overwrote an existing release"
  exit 1
fi
good "refused (exit ${rc}): a published release cannot be replaced."
pause

step "b) Skip ofw: rewrite the release record in place with the raw PDS API"
show "com.atproto.repo.putRecord  collection=app.openfirmware.firmware.release  rkey=${RKEY}"
EVIL_SHA="$(openssl dgst -sha256 -r "${TMP}/payload.txt" | cut -d' ' -f1)"
read -r OLD_CID NEW_CID < <(pds tamper-release "$PUBLISHER_HANDLE" "$RKEY" "$EVIL_SHA")
warn "the PDS accepted the rewrite."
say "content ID before: ${OLD_CID}"
say "content ID after:  ${NEW_CID}"
say "channel pointer, gate and CI acks still name the old content ID"
pause

attack_verdict "$SINCE" "CID|cid|RecordNotFound|not found|mismatch|Could not locate" "$BEFORE" "$PAYLOAD"
say "(Sidekar asks the PDS for the exact content ID the channel pins; that record version is gone.)"

rc=0
step "Independent check: ofw audit"
show "ofw audit --repo ${PUBLISHER_HANDLE} --rkey ${RKEY} --trusted-oem-key ${OEM_PUBLIC_KEY}"
env -u OFW_IDENTIFIER -u OFW_PASSWORD "$OFW" audit --repo "$PUBLISHER_HANDLE" --rkey "$RKEY" \
  --trusted-oem-key "$OEM_PUBLIC_KEY" 2>&1 | sed 's/^/   /' || rc=${PIPESTATUS[0]}
if [[ $rc -eq 0 ]]; then
  bad "expected ofw audit to fail for a rewritten release"
  exit 1
fi
say "exit code ${rc} = do not install"
say "the device keeps running what it verified earlier; the next good release supersedes this one."
