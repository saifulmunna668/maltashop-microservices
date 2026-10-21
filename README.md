# MaltaShop microservices prototype

A working slice of the target architecture proposed for MaltaShop Ltd (electronics and homeware, Malta and Gozo) in the Unit 5 assessment report. It replaces part of the PHP monolith's checkout with separately deployable services, each owning its own data store, and shows the patterns the report argues for:

- **REST** through one API gateway that authenticates customers (token) and partner retailers (API key with per-partner scopes).
- **Checkout saga** across Order, Inventory and Payment: reserve stock, charge, then confirm or release the stock by event (compensation). Every step is idempotent.
- **Asynchronous events via RabbitMQ**, published through a transactional outbox: `OrderPlaced`, `OrderPaymentDeclined`, `OrderCancelled` and `ProductViewed`. Inventory, Notification and the AI recommendation service consume them; none of them is on the checkout path.
- **Observability**: JSON logs with one correlation ID across every service, Prometheus metrics, a checkout SLO with burn-rate alerts, and alerts for the March notification incident pattern.
- **Delivery**: a Dockerfile per service, one `docker compose up`, a CI workflow, an order-service delivery pipeline and Kubernetes manifests.

It is a prototype, not production code. See [Known limitations](#known-limitations).

## Services

| Service | Responsibility | Data store (own) | Talks to |
|---|---|---|---|
| api-gateway | Single public entry point: authentication, scopes, rate limits, routing, recommendation fallback | none (stateless) | all public services |
| catalog-service | Products and prices; emits `ProductViewed` when a customer opens a product | in-memory seed (PostgreSQL in the target design) | RabbitMQ |
| order-service | Orders; runs the checkout saga; transactional outbox | PostgreSQL `orders_db` | catalog, inventory, payment, RabbitMQ |
| inventory-service | Stock levels and reservations; confirms or releases them from order events | PostgreSQL `inventory_db` | RabbitMQ |
| payment-service | Adapter to the external payment provider; stores tokens and outcomes, never card numbers | PostgreSQL `payments_db` | mock payment provider |
| notification-service | Confirmation emails; retries, dead-letter queue, operator replay | processed event IDs in memory (PostgreSQL in the target design) | RabbitMQ, mock email provider |
| recommendation-service | Stands in for the data team's Python model; learns from orders and browsing events | in memory (Redis feature store in the target design) | RabbitMQ |
| mock-payment-provider, mock-email-provider | Stand-ins for the external PSP and email provider | none | none |

## What you need

- Docker Engine 24+ with Docker Compose v2.20+.
- Node.js 22+ and npm, only to run lint and tests from your machine.
- About 3 GB of free memory.

## Run it

```bash
cp .env.example .env     # development values only; change them and never commit .env
docker compose up --build
```

`docker compose up -d --build --wait` does the same in the background and returns when every service is healthy. `docker compose ps` should then show every service as `healthy`. Stop with `docker compose down`, and add `-v` to delete the databases too.

| Address on your machine | What it is |
|---|---|
| http://localhost:8080 | API gateway, the only public entry point |
| http://127.0.0.1:8025/v1/messages | The mock email provider's "inbox" |
| http://127.0.0.1:15672 | RabbitMQ management UI (user and password from `.env`) |
| http://127.0.0.1:9090 | Prometheus: metrics, SLO recording rules and alerts |
| http://127.0.0.1:3001 | Grafana, optional: `docker compose --profile dashboards up -d` |

## Environment variables

All configuration comes from the environment (12-factor "Config"). Docker Compose reads `.env`; `.env.example` lists every value with a safe development default.

**Set in `.env`** (shared by the stack):

| Variable | Used by | Purpose |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | Compose | Prefix for container names (`maltashop`) |
| `IMAGE_TAG` | Compose | Image tag to run (`local`; CI uses the commit SHA) |
| `POSTGRES_PASSWORD` | postgres | Administrator password, used only by the init script |
| `ORDER_DB_PASSWORD`, `PAYMENT_DB_PASSWORD`, `INVENTORY_DB_PASSWORD` | postgres and each owning service | One database login per service: no service can read another's tables |
| `RABBITMQ_USER`, `RABBITMQ_PASSWORD` | rabbitmq and every service that publishes or consumes | Broker credentials |
| `INTERNAL_JWT_SECRET` | every service | Signs and checks the short-lived tokens services use to call each other |
| `EXTERNAL_JWT_SECRET` | api-gateway | Signs customer tokens (a real identity provider replaces this in production) |
| `PSP_API_KEY` | payment-service, mock-payment-provider | Payment provider credential |
| `EMAIL_PROVIDER_API_KEY` | notification-service, mock-email-provider | Email provider credential |
| `ADMIN_TOKEN` | notification-service | Protects the operator's dead-letter replay endpoint |
| `GRAFANA_ADMIN_PASSWORD` | grafana | Dashboard login |
| `DEMO_USERS` | api-gateway | Demo customers, with SHA-256 password hashes |
| `PARTNER_KEYS` | api-gateway | Partner retailers: SHA-256 hash of each API key and that partner's scopes |
| `RECO_FAULT_DELAY_MS`, `RECO_FAULT_ERROR_RATE` | recommendation-service | Fault injection: slow or failing recommendations (0 = off) |
| `PSP_FAILURE_RATE`, `EMAIL_FAILURE_RATE` | mock providers | Fault injection: share of calls that fail, 0 to 1 |

**Set per service in `docker-compose.yml`** (wiring and tuning; change them there or in the Kubernetes ConfigMap):

| Variable | Service(s) | Default in Compose |
|---|---|---|
| `PORT` | all | `3000` (gateway `8080`) |
| `LOG_LEVEL`, `SERVICE_VERSION` | all | `info`, image version; written on every log line |
| `DATABASE_URL` | order, payment, inventory | `postgres://<svc>:<password>@postgres:5432/<db>` |
| `AMQP_URL` | catalog, order, inventory, notification, recommendation | `amqp://<user>:<password>@rabbitmq:5672` |
| `CATALOG_URL`, `ORDER_URL`, `INVENTORY_URL`, `PAYMENT_URL`, `RECOMMENDATION_URL` | gateway, order | Internal service addresses |
| `RATE_LIMIT_CUSTOMER`, `RATE_LIMIT_PARTNER` | api-gateway | Requests per minute: `120` and `60` |
| `ENABLE_DEMO_LOGIN` | api-gateway | `true`: enables `POST /auth/token` for the demo customers |
| `PAYMENT_TIMEOUT_MS`, `PAYMENT_CB_FAILURES`, `PAYMENT_CB_RESET_MS` | order-service | Payment call timeout and circuit breaker settings |
| `RESERVATION_TTL_SECONDS` | inventory-service | How long unpaid stock stays reserved: `900` |
| `PSP_BASE_URL`, `PSP_TIMEOUT_MS` | payment-service | Payment provider address and timeout (`2000`) |
| `EMAIL_PROVIDER_URL`, `MAX_ATTEMPTS`, `RETRY_DELAY_MS` | notification-service | Email provider, attempts before the dead-letter queue (`4`), retry delay (`5000`) |
| `METRICS_PORT` | api-gateway | Separate port for `/metrics`, so it is not public |

## Demo accounts

| Who | Credential | Can do |
|---|---|---|
| Customer alice | `alice` / `alice-demo-pass` | Browse, order, read her own orders, recommendations |
| Customer bob | `bob` / `bob-demo-pass` | The same, for his own orders only |
| Partner Sliema Retail | API key `sliema-retail-demo-key` | Read the catalogue and stock; read orders placed through Sliema Retail, without customer personal data |
| Partner Gozo Homeware | API key `gozo-homeware-demo-key` | Read the catalogue and stock only |

These are throwaway demo values; only their hashes are in `.env.example`.

## Try it with curl

```bash
# 1. Log in as a customer
TOKEN=$(curl -s -X POST localhost:8080/auth/token -H 'content-type: application/json' \
  -d '{"username":"alice","password":"alice-demo-pass"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')

# 2. Browse. Opening one product emits a ProductViewed event for the recommendation model.
curl -s localhost:8080/api/v1/products -H "authorization: Bearer $TOKEN"
curl -s localhost:8080/api/v1/products/p-1003 -H "authorization: Bearer $TOKEN"
curl -s "localhost:8080/api/v1/stock?ids=p-1001,p-1003" -H "authorization: Bearer $TOKEN"

# 3. Check out: the REST call. The response header X-Request-Id is the correlation ID.
#    Sending the same Idempotency-Key again returns the same order and never charges twice.
curl -si -X POST localhost:8080/api/v1/orders \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'idempotency-key: demo-order-0001' \
  -d '{"items":[{"productId":"p-1001","quantity":1}],"paymentToken":"tok_visa","partnerRef":"partner-sliema-retail"}'

# 4. The event consumed by other services: stock confirmed, email sent
docker compose logs inventory-service notification-service | grep OrderPlaced
curl -s localhost:8025/v1/messages

# 5. Follow one correlation ID through every service (replace with the X-Request-Id from step 3)
docker compose logs --no-log-prefix | grep '"correlationId":"<id>"'

# 6. Recommendations (the gateway waits 300 ms at most, then falls back to bestsellers)
curl -s localhost:8080/api/v1/recommendations -H "authorization: Bearer $TOKEN"

# 7. Partner view: only Sliema Retail's orders, no customer data
curl -s localhost:8080/api/v1/orders -H 'x-api-key: sliema-retail-demo-key'
```

Other outcomes to try:

| Request | Result |
|---|---|
| `"paymentToken":"tok_declined"` | `402 PAYMENT_DECLINED`; the reserved stock is released by the `OrderPaymentDeclined` event (compensation) |
| `"items":[{"productId":"p-1008","quantity":1}]` | `409 OUT_OF_STOCK` before any payment is attempted |
| A card number as `paymentToken` | `422 PAYMENT_REJECTED`: the platform only ever handles provider tokens |
| The Gozo Homeware key on `GET /api/v1/orders/<id>` | `403`: that partner has no order scope |

## Tests

| Command | What it checks | Needs the stack |
|---|---|---|
| `npm ci && npm run lint` | ESLint over every service and test | No |
| `npm run check:shared` | The shared helpers copied into each service are identical to `services/_shared` | No |
| `npm run test:unit` | Unit, API and contract tests: 65 tests across 9 services and mocks | No |
| `npm run test:e2e` | 24 end-to-end checks through the gateway: login, checkout saga, idempotency, compensation, out of stock, access control, events, recommendations, emails, one correlation ID in five services | Yes |
| `npm run test:scenarios` | 13 checks in four failure scenarios, about 3 minutes | Yes |

**Contract test.** `contracts/order-service--payment-service.json` is a consumer-driven contract: what order-service expects from payment-service (approved, declined, card number refused). `services/order-service/test/contract.test.js` checks the consumer against it; `services/payment-service/test/contract.test.js` checks the real provider against the same file. If payment-service changes a response that order-service relies on, the provider test fails before release.

**Failure scenarios** (`node tests/e2e/scenarios.mjs <name>`):

| Scenario | What it does | What should happen |
|---|---|---|
| `reco` | Stops recommendation-service | Recommendations fall back to bestsellers within 300 ms; checkout still works |
| `payment` | Stops the payment provider | Checkout returns `503` and keeps the order `PAYMENT_UNCONFIRMED`; the retry with the same key completes the same order with one charge |
| `broker` | Stops RabbitMQ | Checkout still succeeds; the event waits in the outbox and is delivered after RabbitMQ returns |
| `notification` | Stops the email provider | Checkout still succeeds; the message is retried, parked in the dead-letter queue, the `NotificationDeadLettersPresent` alert fires, and after an operator replay the email arrives |

Saved outputs of every check are in `../04_evidence/test-output/` of the submission folder.

## Operations

Replay the notification dead-letter queue after fixing the cause:

```bash
docker compose exec notification-service node -e \
  "fetch('http://127.0.0.1:3000/internal/dlq/replay',{method:'POST',headers:{authorization:'Bearer '+process.env.ADMIN_TOKEN}}).then(r=>r.text()).then(console.log)"
```

Alerts are at http://127.0.0.1:9090/alerts. They include the checkout SLO burn-rate alerts (`CheckoutSLOFastBurn`, `CheckoutSLOSlowBurn`) and `NotificationMemoryHigh`, which would have flagged the March memory leak before it crashed anything. Queues to watch in RabbitMQ: `inventory.order-events`, `notification.order-events`, `notification.retry`, `notification.dlq` and `recommendation.events`.

## CI/CD

- `.github/workflows/ci.yml` runs on every pull request and push to `main`: lint, unit tests per service, a secret scan, Kubernetes manifest validation for staging and production, then it builds every image once, scans it with Trivy, starts the stack and runs the smoke test and failure scenarios. On `main` it publishes the tested images.
- `.github/workflows/order-service-delivery.yml` is the delivery pipeline for one service: verify (unit and contract tests) → build once, scan, push and record the digest → deploy that digest to staging and smoke test → manual approval → rolling update in production, with automatic `rollout undo` if it fails. The deploy stages run only after you set the repository variable `KUBE_DEPLOY_ENABLED=true`, the variable `STAGING_GATEWAY_URL`, the secrets `KUBECONFIG_STAGING` and `KUBECONFIG_PRODUCTION`, and required reviewers on the `production` environment.

Before using the workflows for real, pin every `uses:` action to a full commit SHA; they are pinned to major versions here.

## Kubernetes

`k8s/base` holds one Deployment, Service and probes per service, HorizontalPodAutoscalers, PodDisruptionBudgets and NetworkPolicies. `k8s/overlays/staging` and `k8s/overlays/production` set the namespace, replicas and images. Databases and the broker are expected to be managed services outside the cluster, so the cluster holds no state. Validate with:

```bash
kustomize build k8s/overlays/production | kubeconform -strict -summary
```

## Repository layout

```
services/<name>/        one folder per service: src/, test/, Dockerfile, package.json
services/_shared/       logger, metrics, auth, HTTP and health helpers, copied into each service
contracts/              consumer-driven contract and its matcher
infra/                  PostgreSQL init, RabbitMQ plugins, Prometheus rules and alerts, Grafana
k8s/                    kustomize base plus staging and production overlays
.github/workflows/      ci.yml and order-service-delivery.yml
tests/e2e/              end-to-end and failure-scenario scripts
docs/diagrams/          Mermaid sources (.mmd) and rendered .svg/.png
```

Each service builds its own image from its own folder, so the shared helpers are copied in rather than imported. After changing `services/_shared`, run `bash scripts/sync-shared.sh`; CI fails if the copies drift.

## Known limitations

- Demo login and a shared HS256 signing secret stand in for a real identity provider (OpenID Connect) and for mutual TLS between services.
- The catalogue, notification log and recommendation model keep their data in memory; the target design gives them PostgreSQL and Redis.
- One PostgreSQL server hosts three separate databases with separate logins; production should use separate managed instances.
- The customer's email address travels inside `OrderPlaced` so Notification can work alone. That copies personal data into the broker; it is limited by queue permissions, a 7-day dead-letter expiry and log redaction.
- Retries use a fixed delay rather than exponential back-off; there is no distributed tracing yet, only the correlation ID.
- The Kubernetes manifests are validated but not deployed to a cluster, and the GitHub workflows have been linted but have not yet run on GitHub.
