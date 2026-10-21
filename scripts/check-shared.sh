#!/usr/bin/env bash
# Each service is built on its own (own image, own pipeline), so the small shared helpers in
# services/_shared are COPIED into every service's src/lib. This check fails CI if a copy drifts.
set -euo pipefail
cd "$(dirname "$0")/../services"
status=0
for svc in api-gateway catalog-service inventory-service order-service payment-service recommendation-service notification-service; do
  for f in _shared/*.js; do
    if ! cmp -s "$f" "$svc/src/lib/$(basename "$f")"; then echo "DRIFT: $svc/src/lib/$(basename "$f")"; status=1; fi
  done
done
[ $status -eq 0 ] && echo "shared helpers in sync"
exit $status
