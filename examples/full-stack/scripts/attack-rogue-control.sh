#!/usr/bin/env bash
# ATTACK 4 (IoT) — a camera is pointed at a control plane it was not built for.
#
# The camera's factory profile pins the job-signing key of the OEM's real
# control plane. Here the device is redirected (DNS hijack, wrong network,
# resold hardware…) to a control plane holding a DIFFERENT key — played by
# the demo control plane. An admin there approves it and queues a password
# change. The device must refuse to enroll, so the job is never applied.
#
#   ./scripts/attack-rogue-control.sh
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_iot
need_tools openssl

CAM_ROOT="${LOCAL}/camera/rogue-$(date +%s)"
CAM_LOG="${CAM_ROOT}.log"
mkdir -p "$(dirname "$CAM_ROOT")"
trap stop_camera EXIT
SERIAL="$(next_serial)"
REAL_KEY="$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n')"
ROGUE_KEY="$(ofw_util control-key)"

attack_banner "camera redirected to a control plane it does not trust" \
  "key pinned in the camera at the factory: ${REAL_KEY}" \
  "key of the control plane it now reaches: ${ROGUE_KEY}"
pause

step "Camera ${SERIAL} boots and reaches the rogue control plane"
CAMERA_ROOT="$CAM_ROOT" OFW_CONTROL_PUBLIC_KEY="$REAL_KEY" SERIAL="$SERIAL" \
  OFW_FACTORY_SECRET="${OFW_FACTORY_SECRET:-demo-factory-secret}" node "$CAMERA_JS" init >/dev/null
FP="$(camera_fingerprint "$CAM_ROOT")"
start_camera "$CAM_ROOT" "$CAM_LOG"
wait_until 20 grep -q 'joinRequest:' "$CAM_LOG" || { cat "$CAM_LOG"; die "the camera did not send a join request"; }
grep -E 'joinRequest' "$CAM_LOG" | sed 's/^ */   camera | /'

step "The rogue admin approves it and queues a password change"
JOIN_ID="$(ofw_util list-pending | awk -F'\t' -v s="$SERIAL" '$3 == s { print $1 }' | tail -1)"
[[ -n "$JOIN_ID" ]] || die "no pending join for ${SERIAL}"
show "ofw-util approve ${JOIN_ID}"
ofw_util approve "$JOIN_ID" | sed 's/^/   /'
show "ofw-util set-password ${FP:0:16}… 'attacker-password'"
JOB_ID="$(ofw_util set-password "$FP" 'attacker-password' | awk '{ print $2 }')"
say "queued ${JOB_ID}"
pause

step "What the camera did"
if wait_until 20 grep -q 'does not match the pinned key' "$CAM_LOG"; then
  printf '   %scamera | %s%s\n' "$C_YELLOW" "$(grep -m1 'does not match the pinned key' "$CAM_LOG" | sed 's/^loop error //')" "$C_OFF"
else
  tail -5 "$CAM_LOG"
  bad "the camera did not report a pinned-key mismatch"
  exit 1
fi
sleep 2
if grep -q 'credential.set: ok' "$CAM_LOG" ||
  CAMERA_ROOT="$CAM_ROOT" node "$CAMERA_JS" status | grep -q '"passwordRotated": true'; then
  bad "FAILED OPEN: the camera applied a job from an untrusted control plane"
  exit 1
fi
say "job status on the rogue control plane: $(ofw_util list-jobs | awk -F'\t' -v j="$JOB_ID" '$1 == j { print $3 }')"
say "camera password: unchanged (factory default)"
printf '\n%sBLOCKED%s  %s\n' "$C_GREEN" "$C_OFF" "the camera never enrolled, so the job was never fetched or applied."
