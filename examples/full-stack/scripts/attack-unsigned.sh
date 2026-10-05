#!/usr/bin/env bash
# ATTACK 1 — stolen publisher password, no OEM key, CI bypassed.
#
# The attacker logs in to the PDS as the publisher and publishes a release
# straight to the stable channel. The PDS accepts it (it is the publisher's
# repo) and the channel pointer moves. Sidekar must refuse it: there is no
# attestation from the CI account, and no signature from the pinned OEM key.
#
#   ./scripts/attack-unsigned.sh ["attacker payload"]
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_stack

PAYLOAD="${1:-PWNED: unsigned release pushed with a stolen password}"
VERSION="${VERSION:-$(pds next-version "$PUBLISHER_DID" "$PRODUCT")}"
RKEY="$(release_rkey "$VERSION")"
BEFORE="$(site_message)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf '%s' "$PAYLOAD" >"${TMP}/payload.txt"
SINCE="$(now_utc)"

attack_banner "stolen publisher password — unsigned release, CI skipped" \
  "the attacker has the PDS password, but not the OEM key and not the CI account" \
  "demo site currently says: \"${BEFORE}\""
pause

step "Attacker publishes ${PRODUCT} ${VERSION} straight to ${CHANNEL} (no --oem-key, no CI gate)"
show "ofw publish --product ${PRODUCT} --version ${VERSION} --kind package --file evil.txt --skip-pipeline --yes"
"$OFW" publish --product "$PRODUCT" --version "$VERSION" --channel "$CHANNEL" --kind package \
  --file "${TMP}/payload.txt" --skip-pipeline --yes 2>&1 | sed 's/^/   /'
warn "the PDS accepted it: gate = $(pds gate "$PUBLISHER_DID" "$RKEY"), channel ${PRODUCT}/${CHANNEL} -> $(pds live-version "$PUBLISHER_DID" "$PRODUCT" "$CHANNEL")"
pause

attack_verdict "$SINCE" "$VERSION" "$BEFORE" "$PAYLOAD"
audit_expect_fail "$RKEY"
say "recover: publish the next good release (./scripts/demo-happy-path.sh) — it supersedes this one."
