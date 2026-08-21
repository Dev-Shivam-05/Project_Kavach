#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Phase 1's last arrow, end to end, without Docker (D-027 · D-026 · ADR-002)
#
#   bash ops/e2e-two-binaries.sh /tmp/kavach-e2e
#
# This is ops/docker-compose.yml with the containers taken away: sos-ingest and
# control-plane as two separate OS processes, both pointed at ONE
# KAVACH_BUS_DIR, and one real SOS posted to sos-ingest's actual HTTP front
# door. It exists because every other piece of evidence for D-027 is a Go test,
# and a Go test cannot answer "do the two BINARIES talk".
#
# What a good run looks like (~40 s):
#
#   enrolment                5 × 201 through the control plane's API (RISK 18)
#   sos-ingest store         family.json + member.json + device.json, learnt
#                            over the bus — nothing writes into that directory
#   ack                      {"incidentId":…,"verified":false,"flags":1}
#   control-plane log        ingest_incident_projected   <- it heard the other process
#   control-plane store      AUTO_QUIESCE + CANCEL_WINDOW armed
#   after the cancel window  transition PENDING -> ACTIVE_L1
#                            REPEAT_L1, SMS_TIER, ESCALATE_L2, ESCALATE_L3 armed
#   fanout                   tier=1 label=L1 devices=1   <- Amit; Priya is the
#                            subject and tierDevices skips her own phone
#   cursors                  BOTH durables recorded, neither erased by the other
#
# Two things it does NOT prove, and neither is a defect in this script:
#   - Nobody's phone rings. `devices 1` means addressed, not delivered:
#     KAVACH_FCM_CREDENTIALS is unset and the enrolled key is 32 zero bytes
#     (RISK 14).
#   - The four-container stack still has never been brought up. This is two of
#     the four binaries on one host.
#
# The envelope it posts is unsigned, so it is accepted, flagged and counted —
# ADR-018, fail open on the safety path. That is the product, not a shortcut.
# ═══════════════════════════════════════════════════════════════════════════════
set -u

ROOT="$(cd "$(dirname "$0")/../backend" && pwd)"
E2E="${1:?usage: e2e-two-binaries.sh <empty-work-dir>}"
BIN="$E2E/bin"
DATA="$E2E/data"          # sos-ingest: KAVACH_SOS_DATA -> <data>/bus, <data>/store
CP="$E2E/cp"              # control-plane: KAVACH_DATA_DIR
BUS="$DATA/bus"           # the seam

mkdir -p "$BIN" "$DATA/store" "$CP" "$BUS"

FAM=f-e2e
MEM=m-e2e                 # Priya, adult — the SOS subject
DEV=d-e2e                 # Priya's phone, the one the envelope comes from
RES=r-e2e                 # Amit, guardian — the responder
RDEV=rd-e2e               # Amit's phone, the one the fan-out must reach
INC=11111111-2222-4333-8444-555555555555
# 32 zero bytes: a well-formed Ed25519 public key that verifies nothing. The
# envelope below is unsigned on purpose (ADR-018), so no real key is needed.
PUBKEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=

echo "== building both binaries =="
cd "$ROOT" || exit 1
go build -o "$BIN/" ./cmd/sos-ingest ./cmd/control-plane || exit 1

echo "== starting sos-ingest (:18081) and control-plane (:18080) on one bus dir =="
KAVACH_SOS_ADDR=":18081" KAVACH_SOS_DATA="$DATA" KAVACH_DEV=1 \
  "$BIN/sos-ingest"* > "$E2E/sos-ingest.log" 2>&1 &
SOS_PID=$!
KAVACH_CP_ADDR=":18080" KAVACH_DATA_DIR="$CP" KAVACH_BUS_DIR="$BUS" \
  KAVACH_ESCALATION_WORKERS=1 KAVACH_DEV=1 \
  "$BIN/control-plane"* > "$E2E/control-plane.log" 2>&1 &
CP_PID=$!
trap 'kill $SOS_PID $CP_PID 2>/dev/null' EXIT

sleep 4
echo "sos-ingest  /healthz: $(curl -s -m 3 http://127.0.0.1:18081/healthz | head -c 90)"
echo "control-plane /readyz: $(curl -s -m 3 http://127.0.0.1:18080/readyz | head -c 90)"

echo
echo "== enrolment, through the control plane's API (RISK item 18) =="
# Until 21 Aug this was a shell function that wrote family.json and member.json
# straight into BOTH store directories, because no running binary could create a
# family. It is four requests now.
#
# ★ sos-ingest is not written to at all. It learns every row over the bus
# (bus.KindEnrolmentUpsert on fam.<id>.enrolment) — the same seam D-027 made real
# for incidents — and until it has the family row it answers an SOS with 404
# unknown family, which is why the sleep below is not decoration.
cp_post() { # cp_post <path> <json>
  curl -s -m 5 -o /dev/null -w "%{http_code} $1\n" -X POST "http://127.0.0.1:18080$1" \
    -H 'Content-Type: application/json' -H "X-Family-Id: $FAM" \
    -H "Idempotency-Key: e2e-$(echo "$1$2" | cksum | cut -d' ' -f1)" --data-binary "$2"
}
cp_post /v1/family  "{\"id\":\"$FAM\",\"displayName\":\"E2E Family\"}"
cp_post /v1/members "{\"id\":\"$MEM\",\"displayName\":\"Priya\",\"asciiShortName\":\"PRIYA\",\"role\":\"adult\",\"phoneE164\":\"+919812345678\"}"
cp_post /v1/members "{\"id\":\"$RES\",\"displayName\":\"Amit\",\"asciiShortName\":\"AMIT\",\"role\":\"guardian\",\"phoneE164\":\"+919812345679\"}"
cp_post /v1/devices "{\"id\":\"$DEV\",\"memberId\":\"$MEM\",\"platform\":\"android\",\"signingPubkey\":\"$PUBKEY\"}"
cp_post /v1/devices "{\"id\":\"$RDEV\",\"memberId\":\"$RES\",\"platform\":\"android\",\"signingPubkey\":\"$PUBKEY\"}"

echo "-- waiting 2s for the rows to cross the bus into sos-ingest --"
sleep 2
echo "sos-ingest store now holds: $(ls "$DATA/store" | xargs echo)"

echo
echo "== POST a real SOS to sos-ingest =="
NOW=$(date +%s)000
cat > "$E2E/envelope.json" <<JSON
{"v":1,"incidentId":"$INC","familyId":"$FAM","deviceId":"$DEV","memberId":"$MEM","clientTsMs":$NOW,"hlc":"$NOW:0:$DEV","trigger":"manual","confidencePct":95,"riskContext":0,"duress":false,"isDrill":false,"policyVersion":1,"coarseCell":"tdr1x","batteryPct":80,"sealedPayload":"","flags":0,"pad":""}
JSON
curl -s -m 5 -X POST http://127.0.0.1:18081/v1/incident/open \
  -H 'Content-Type: application/json' --data-binary "@$E2E/envelope.json"
echo

echo
echo "== waiting 32s: the 250 ms bus poll, the 20 s cancel window, then the ladder =="
sleep 32

echo
echo "== the rungs the ENGINE armed, in the control-plane's own store =="
grep -o '"action":"[A-Z_0-9]*","target_tier":[0-9]*' "$CP/escalation_timer.json" 2>/dev/null
echo
echo "== the incident the control-plane projected =="
grep -o '"id":"[^"]*","family_id":"[^"]*"\|"state":"[A-Z_0-9]*"' "$CP/incident.json" 2>/dev/null | head -3
echo
echo "== the seam =="
echo "stream.wal: $(stat -c %s "$BUS/stream.wal" 2>/dev/null) bytes"
echo "cursors:    $(ls "$BUS/cursors" 2>/dev/null | xargs echo)"
echo
echo "== control-plane: what it heard and what it did =="
grep -E "ingest_incident_projected|timer_armed|transition|fanout" "$E2E/control-plane.log" | tail -12
