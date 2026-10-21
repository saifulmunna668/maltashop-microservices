#!/usr/bin/env bash
# Install and unit-test every service (same commands CI runs).
set -euo pipefail
cd "$(dirname "$0")/../services"
for dir in */; do
  svc="${dir%/}"; [ "$svc" = "_shared" ] && continue
  echo "=== $svc"
  (cd "$svc" && npm ci --no-audit --no-fund --loglevel=error && npm test)
done
