#!/usr/bin/env bash
# Copy services/_shared/*.js into every service after editing a shared helper.
set -euo pipefail
cd "$(dirname "$0")/../services"
for svc in api-gateway catalog-service inventory-service order-service payment-service recommendation-service notification-service; do
  mkdir -p "$svc/src/lib" && cp _shared/*.js "$svc/src/lib/"
done
echo "synced"
