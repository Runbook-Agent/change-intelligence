#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_BASE="${CHANGE_INTEL_API_BASE:-http://localhost:3001/api/v1}"

AUTH_ARGS=()
if [[ -n "${CHANGE_INTEL_ADMIN_TOKEN:-}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${CHANGE_INTEL_ADMIN_TOKEN}")
fi

post_json_file() {
  local path="$1"
  local file="$2"
  curl -sS -X POST "${API_BASE}${path}" \
    ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
    -H 'Content-Type: application/json' \
    --data @"${file}"
  echo
}

echo "== Change Intelligence Demo Seed =="
echo "API: ${API_BASE}"
echo

echo "[1/6] Health check"
curl -sS "${API_BASE}/health"
echo
echo

echo "[2/6] Import demo graph"
post_json_file "/graph/import" "${ROOT_DIR}/examples/demo-graph.json"
echo

echo "[3/6] Ingest demo events batch"
post_json_file "/events/batch" "${ROOT_DIR}/examples/demo-events.json"
echo

echo "[4/6] Correlate likely causes for a checkout incident"
post_json_file "/correlate" "${ROOT_DIR}/examples/demo-correlate-request.json"
echo

echo "[5/6] Run triage"
post_json_file "/triage" "${ROOT_DIR}/examples/demo-triage-request.json"
echo

echo "[6/6] Predict blast radius"
post_json_file "/blast-radius" "${ROOT_DIR}/examples/demo-blast-radius-request.json"
echo

echo "Demo seed complete."
