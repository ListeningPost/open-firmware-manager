#!/usr/bin/env bash
# Step 1 of the happy path only: publish an OEM-signed release that needs CI
# acks, and stop. The gate stays awaiting-pipeline and the channel does not
# move until the publisher promotes it:
#
#   ./scripts/publish-with-pipeline.sh "Hello after tests"
#   ./scripts/promote.sh            # promotes the newest release
exec env NO_PROMOTE=1 "$(dirname "$0")/demo-happy-path.sh" "$@"
