## Quick start

Prerequisites: Docker (with Compose v2) and Node 24 (only needed for the helper scripts).

```bash
docker compose up --build -d     # Postgres, Redpanda (+ topics), Redpanda Console, migrate+seed, app
npm ci                           # for the token / publish helper scripts
```

| What                           | URL                                                                    |
| ------------------------------ | ---------------------------------------------------------------------- |
| Public API                     | http://localhost:3000/v1                                               |
| OpenAPI (Swagger UI)           | http://localhost:9464/docs (spec: `/docs/openapi.json`)                |
| Health / readiness             | http://localhost:9464/health/live · http://localhost:9464/health/ready |
| Prometheus metrics             | http://localhost:9464/metrics                                          |
| Redpanda Console (topics, DLQ) | http://localhost:8080                                                  |

Seeded programs: tenant `t-1` has `PRG-USD-001` ($10,000,000.00), `PRG-EUR-001` (€5,000,000.00) and
`PRG-JPY-001` (¥1,000,000,000). Tenant `t-2` has its own `PRG-USD-001` ($2,500,000.00), which shows tenant isolation.

### Get a token

All endpoints require an RS256 bearer JWT. In local dev it is signed with a **dev-only** keypair that is committed in
`dev/jwt/` ([ADR-007](docs/DECISIONS.md#adr-007-authentication--rs256-jwt-global-guard-oauth-style-scopes)). The app refuses to start
with that key when `NODE_ENV=production`.

```bash
export TOKEN=$(npm run -s token -- --tenant t-1)    # scopes: capacity:read capacity:write capacity:audit
npm run -s token -- --tenant t-1 --scopes "capacity:read" --ttl 600   # narrower token
```

### Walk through the API

Money is always `{"amountMinor": "<integer string>", "currency": "<ISO 4217>"}`.

```bash
API=http://localhost:3000/v1/programs/PRG-USD-001
AUTH="Authorization: Bearer $TOKEN"

# 1. Availability
curl -s -H "$AUTH" $API/availability

# 2. Reserve a €100,000.00 invoice in the USD program: the FX rate is locked and the amount rounded up
curl -s -H "$AUTH" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-reserve-1' \
  -d '{"invoiceId":"INV-1001","amount":{"amountMinor":"10000000","currency":"EUR"}}' \
  $API/reservations | tee /tmp/reservation.json
RID=$(python3 -c "import json;print(json.load(open('/tmp/reservation.json'))['id'])")

# 3. Retry the same request: same body, status 201, header Idempotent-Replayed: true, nothing reserved twice
curl -s -i -H "$AUTH" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-reserve-1' \
  -d '{"invoiceId":"INV-1001","amount":{"amountMinor":"10000000","currency":"EUR"}}' \
  $API/reservations | grep -i idempotent-replayed

# 4. Partial repayment of €40,000.00 (Idempotency-Key required): frees the pro-rata share, rounded down
curl -s -H "$AUTH" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-release-1' \
  -d '{"amount":{"amountMinor":"4000000","currency":"EUR"}}' $API/reservations/$RID/releases

# 5. Final repayment: omit the amount to release exactly what remains
curl -s -H "$AUTH" -X POST -H 'Idempotency-Key: demo-release-2' $API/reservations/$RID/releases

# 6. Over the limit → 409 problem+json with a stable code
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"invoiceId":"INV-HUGE","amount":{"amountMinor":"999999999999","currency":"USD"}}' $API/reservations

# 7. Audit trail (capacity:audit): every movement, with correlation IDs; the deltas sum to `reserved`
curl -s -H "$AUTH" "$API/ledger?limit=5"

# 8. Live availability (Server-Sent Events). Run in another terminal, then repeat step 2 with a new invoiceId
curl -N -H "$AUTH" $API/availability/stream
```

Prefer clicking to curl? [`http/`](http/README.md) has a PhpStorm / IntelliJ HTTP Client collection covering every
endpoint, with assertions: run `npm run http:tokens` once, then pick the `local` environment.

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json` documents with a stable `code`
(`INSUFFICIENT_CAPACITY`, `CURRENCY_NOT_SUPPORTED`, `OVER_RELEASE`, `IDEMPOTENCY_KEY_REUSED`, …) and the request's
`correlationId`. See [ADR-015](docs/DECISIONS.md#adr-015-error-format--rfc-9457-problem-details-with-domain-codes) and Swagger.

### Publish treasury messages (Kafka)

```bash
# Raise a limit (programs are also *created* by their first limit message)
npm run publish -- limit --program PRG-USD-001 --currency USD --limit 1200000000

# An external reservation booked by treasury (counts against capacity even beyond the limit, ADR-013)
npm run publish -- ext-reserve --program PRG-USD-001 --ref TRS-1 --amount 25000000 --correlation-id demo-42

# Reconciliation snapshot built from the current DB, split into 3 Kafka messages.
# --omit 1 drops the newest reservation, as if treasury had not seen it yet.
npm run publish -- snapshot --program PRG-USD-001 --parts 3 --omit 1
curl -s -H "$AUTH" $API/discrepancies     # PENDING after one snapshot, OPEN after two, never auto-fixed

# A poison message goes to treasury.capacity.v1.dlq; the partition keeps flowing (see Console :8080)
npm run publish -- poison
```

Each message is keyed `tenantId:programId` (per-program ordering) and carries a per-program monotonic `version`.
The script defaults to `Date.now()` for it. Message schemas are in
[PLAN §2.4](docs/PLAN.md#24-kafka-contract-adr-010) and `src/modules/capacity/messaging/treasury-message.schema.ts`.
A reservation created within the grace window before `asOf` (default 5 minutes) is reported as _uncertain_,
not flagged. Wait a few minutes after creating reservations, or run two snapshots, to see `OPEN` discrepancies.

### Verify the ledger

```bash
docker compose run --rm migrate node dist/database/cli.js verify-ledger   # exit code 2 on any mismatch
```

---

## Running the tests

```bash
npm test                    # unit: domain, money/FX (incl. property-based), schemas, filters     (~1s)
npm run test:e2e            # HTTP end-to-end via Supertest against Postgres (Testcontainers)     (~15s)
npm run test:integration    # Postgres + Redpanda containers: store, concurrency, Kafka, reconciliation (~60s)
npm run lint && npm run typecheck && npm run format:check
```

- **Docker is required** for e2e and integration tests: they start throwaway containers through Testcontainers.
  Testcontainers ignores `docker context`, so the test setup reads the active context's endpoint when
  `DOCKER_HOST` isn't set. OrbStack, Colima and Docker Desktop work without configuration.
  To reuse an existing database instead, set `TEST_DATABASE_URL`.
- Tests isolate by unique tenant IDs rather than truncating, because the ledger is append-only even in tests.
- CI (`.github/workflows/ci.yml`) runs format, lint, typecheck, unit, build, e2e, integration and the Docker image build.

## Local development without the app container

```bash
docker compose up -d postgres redpanda topics
cp .env.example .env
npm run db:migrate && npm run db:seed
npm run start:dev
```

Configuration is validated at boot (zod) and fails fast. Every variable is documented in [`.env.example`](.env.example).
