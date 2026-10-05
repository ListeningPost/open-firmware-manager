#!/usr/bin/env bash
# Run the demo CI attester once, from the host, instead of the pipeline-runner
# container (e.g. after `docker compose stop pipeline-runner`). It logs in as
# the CI account and acks build+test for every release awaiting the pipeline.
# It cannot promote: run ./scripts/promote.sh afterwards.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_stack

PDS_URL="$OFW_PDS" AUTHOR_DID="$PUBLISHER_DID" ONCE=1 AUTO_ACK=1 \
  OFW_CI_IDENTIFIER="$CI_HANDLE" OFW_CI_PASSWORD="${CI_PASSWORD:-ci-pass-change-me}" \
  STAGES="${STAGES:-build,test}" \
  node "${ROOT}/services/pipeline-runner/runner.mjs"
