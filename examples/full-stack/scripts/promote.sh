#!/usr/bin/env bash
# Publisher step: promote a release once the CI attester has acked it.
#   ./scripts/promote.sh [version]     default: the newest published version
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_stack

if [[ -n "${1:-}" ]]; then
  VERSION="$1"
else
  NEXT="$(pds next-version "$PUBLISHER_DID" "$PRODUCT")"
  VERSION="${NEXT%.*}.$((${NEXT##*.} - 1))"
fi
RKEY="$(release_rkey "$VERSION")"

step "Publisher promotes ${RKEY} — only acks from ${CI_HANDLE} count"
show "ofw pipeline-promote --rkey ${RKEY} --attester-did ${CI_DID}"
"$OFW" pipeline-promote --rkey "$RKEY" --attester-did "$CI_DID" 2>&1 | sed 's/^/   /'
good "gate = $(pds gate "$PUBLISHER_DID" "$RKEY"); channel ${PRODUCT}/${CHANNEL} -> $(pds live-version "$PUBLISHER_DID" "$PRODUCT" "$CHANNEL")"
