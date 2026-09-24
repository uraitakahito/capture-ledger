#!/usr/bin/env bash
#
# End-to-end smoke test of the production image against a real stack.
#
# Brings the stack up with container-compose, waits for BrowserHive to answer,
# then runs migrate → seed → the API from the freshly built capture-ledger image, and
# tears everything down through an EXIT trap.
#
# **It no longer captures anything.** capture-ledger does not talk to BrowserHive
# any more — the Windmill flow submits, and capture-ledger plans and records. What this
# script proves is that the image boots: migrations apply, the seed lands, and
# the API answers. The capture path is covered end to end by capture-scheduler's
# `pnpm run test:e2e`, which needs Windmill as well.
#
# The one-shot jobs are `container run` rather than compose services:
# container-compose has exactly four subcommands (up / down / build / version),
# so there is no `run` to lean on. Calling the runtime directly is also what
# retires the old `--profile run --exit-code-from capture-ledger` workaround — the
# Docker Compose behaviour that made it necessary (aborting the whole stack on
# the migrator's legitimate exit 0) has no equivalent here.
set -euo pipefail

cd "$(dirname "$0")/.."

# **コンテナの名前で正しい。** この値は `container run -e` で渡す先、つまりコンテナの中で
# 使われる。ホスト側の `.env` は `127.0.0.1:5432` を使う (macOS 26 では host の node が
# コンテナの subnet へ TCP を張れないため)。ここを 127.0.0.1 にすると、コンテナが自分自身を指す。
DATABASE_URL="postgres://capture_ledger:capture_ledger@postgres.capture-ledger:5432/capture_ledger"
# One BrowserHive per browser (docker-compose.yml), so readiness is both of them.
HEALTH_TARGETS=("localhost:50051" "localhost:50052")
HEALTH_TIMEOUT_S="${BROWSERHIVE_HEALTHCHECK_TIMEOUT_S:-180}"

# The API reads the bucket itself: the level handler picks up each capture's
# `.result.json` manifest and `.links.json` at the keys the level report carries,
# and the picker serves the archives. So the S3 settings belong to the API run and
# not just to BrowserHive.
# The store is the shared one (seaweedfs.crawler-storage) — this script does not bring
# it up, so start it first: sh .upstream/seaweedfs/scripts/stack.sh up. Path-style because
# the bundled SeaweedFS has no wildcard DNS for the bucket subdomain.
S3_ENV=(
  -e "CAPTURE_LEDGER_S3_ENDPOINT=http://seaweedfs.crawler-storage:8333"
  -e "CAPTURE_LEDGER_S3_REGION=us-east-1"
  -e "CAPTURE_LEDGER_S3_BUCKET=browserhive"
  -e "CAPTURE_LEDGER_S3_ACCESS_KEY_ID=browserhive"
  -e "CAPTURE_LEDGER_S3_SECRET_ACCESS_KEY=browserhive"
  -e "CAPTURE_LEDGER_S3_FORCE_PATH_STYLE=true"
)
TEAR_DOWN_ON_EXIT="${TEAR_DOWN_ON_EXIT:-1}"

log() { echo "[$(date +%H:%M:%S)] $*"; }

teardown() {
  if [[ "${TEAR_DOWN_ON_EXIT}" == "1" ]]; then
    log "Tearing the stack down..."
    container-compose down >/dev/null 2>&1 || true
  else
    log "TEAR_DOWN_ON_EXIT=0 — leaving the stack up for inspection."
  fi
}
trap teardown EXIT

# Pass the submodule versions as build args. Without them the image calls itself
# "unknown", and that value is baked into every archive it produces. This script
# does not go through scripts/stack.sh, so it has to source the same helper —
# one place computes the answer, both entry points read it.
# shellcheck source=scripts/submodule-versions.sh
. "$(dirname "$0")/submodule-versions.sh"
export_submodule_versions

log "Starting the stack..."
container-compose up -d -b

# container-compose has no healthcheck support, so readiness is ours to check.
# The probe is a real GET /status (BrowserHive's HTTP API since v12) — which is
# also the strongest readiness signal available: the server only starts listening
# once it has connected to its browser, so an answer means the whole pair is up.
probe() {
  local target
  for target in "${HEALTH_TARGETS[@]}"; do
    curl -fsS "http://${target}/status" >/dev/null 2>&1 || return 1
  done
}
log "Waiting for BrowserHive (up to ${HEALTH_TIMEOUT_S}s)..."
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
until probe; do
  if (( SECONDS >= deadline )); then
    log "ERROR: BrowserHive never answered at ${HEALTH_TARGETS[*]}"
    exit 1
  fi
  sleep 1
done
log "Both BrowserHives are ready."

log "Building the capture-ledger image..."
container build -t capture-ledger:latest .

# The image's ENTRYPOINT is `node dist/api/server.js`, so the db jobs have to
# override it.
run_job() {
  local label="$1"; shift
  log "Running ${label}..."
  container run --rm --entrypoint node \
    -e "DATABASE_URL=${DATABASE_URL}" \
    -e "LOG_LEVEL=${LOG_LEVEL:-info}" \
    capture-ledger:latest "$@"
}

run_job "migrations" dist/db/migrate.js up
run_job "seed" dist/db/seed.js up

# The API is a server, not a job: run it detached, ask it one question, stop it.
# `/healthz` needs neither a token nor FGA, which is what makes it usable here.
log "Starting the API..."
API_ID=$(container run -d --rm \
  -e "DATABASE_URL=${DATABASE_URL}" \
  -e "LOG_LEVEL=${LOG_LEVEL:-info}" \
  -e "CAPTURE_LEDGER_API_HOST=0.0.0.0" \
  "${S3_ENV[@]}" \
  -p 7070:7070 \
  capture-ledger:latest)
trap 'container stop "${API_ID}" >/dev/null 2>&1 || true' EXIT

log "Waiting for the API..."
CAPTURE_LEDGER_EXIT=1
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:7070/healthz" >/dev/null 2>&1; then
    CAPTURE_LEDGER_EXIT=0
    break
  fi
  sleep 2
done

if [ "${CAPTURE_LEDGER_EXIT}" -ne 0 ]; then
  log "The API did not answer /healthz. Recent output:"
  container logs "${API_ID}" 2>&1 | tail -40
fi

log "All done. capture-ledger exit code: ${CAPTURE_LEDGER_EXIT}"
exit "${CAPTURE_LEDGER_EXIT}"
