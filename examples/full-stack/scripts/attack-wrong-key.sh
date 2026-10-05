#!/usr/bin/env bash
# ATTACK 2 — stolen publisher password, attacker signs with their OWN key and
# lets the release go through CI.
#
# The release carries a perfectly valid Ed25519 signature — from a key nobody
# pinned. CI builds and tests it and attests honestly, the attacker (as the
# publisher) promotes it, the channel moves. Sidekar must still refuse: the
# signing key is not the OEM key it trusts.
#
#   ./scripts/attack-wrong-key.sh ["attacker payload"]
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_stack
need_tools openssl

PAYLOAD="${1:-PWNED: signed with a key the attacker made up}"
VERSION="${VERSION:-$(pds next-version "$PUBLISHER_DID" "$PRODUCT")}"
RKEY="$(release_rkey "$VERSION")"
BEFORE="$(site_message)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf '%s' "$PAYLOAD" >"${TMP}/payload.txt"
openssl genpkey -algorithm ed25519 -out "${TMP}/attacker.pem"
ATTACKER_KEY="$(oem_public_key "${TMP}/attacker.pem")"
SINCE="$(now_utc)"

attack_banner "stolen publisher password — release signed with the attacker's own key, passed through CI" \
  "attacker key:      ${ATTACKER_KEY}" \
  "Sidekar trusts:    ${OEM_PUBLIC_KEY}" \
  "demo site currently says: \"${BEFORE}\""
pause

step "Attacker publishes ${PRODUCT} ${VERSION}, signed with their own key"
show "ofw publish --product ${PRODUCT} --version ${VERSION} --kind package --file evil.txt \\"
show "      --require-pipeline --stages build,test --oem-key attacker.pem --yes"
"$OFW" publish --product "$PRODUCT" --version "$VERSION" --channel "$CHANNEL" --kind package \
  --file "${TMP}/payload.txt" --require-pipeline --stages build,test \
  --oem-key "${TMP}/attacker.pem" --oem-key-id totally-legit --yes 2>&1 | grep -v '^  Next:' | sed 's/^/   /'

step "CI attests it (the code builds and the tests pass), the attacker promotes it"
pds wait-acks "$PUBLISHER_DID" "$RKEY" "$CI_DID" build,test 60
show "ofw pipeline-promote --rkey ${RKEY} --attester-did ${CI_DID}"
"$OFW" pipeline-promote --rkey "$RKEY" --attester-did "$CI_DID" 2>&1 | sed 's/^/   /'
warn "gate = $(pds gate "$PUBLISHER_DID" "$RKEY"), channel ${PRODUCT}/${CHANNEL} -> $(pds live-version "$PUBLISHER_DID" "$PRODUCT" "$CHANNEL"): every server-side check passed"
pause

attack_verdict "$SINCE" "OEM_SIG" "$BEFORE" "$PAYLOAD"
audit_expect_fail "$RKEY"
say "recover: publish the next good release (./scripts/demo-happy-path.sh) — it supersedes this one."
