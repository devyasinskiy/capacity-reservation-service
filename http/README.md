# HTTP request collection (PhpStorm / IntelliJ HTTP Client)

Ready-to-run requests for every endpoint, with assertions. Open any `.http` file in PhpStorm (or WebStorm,
IntelliJ IDEA Ultimate) and run single requests with ▶ in the gutter, or a whole file with ▶▶ at the top.

## Setup (once)

```bash
docker compose up --build -d   # from the repo root: the stack must be running
npm run http:tokens            # writes http/http-client.private.env.json (git-ignored)
```

Then pick the **`local`** environment in the run-environment selector at the top of the editor.

The HTTP Client can't sign RS256 JWTs, so `npm run http:tokens` mints them with the dev key (ADR-007). They're valid
for 12 hours (`-- --ttl <seconds>` to change). Re-run it when requests start returning 401.

| Variable        | Tenant | Scopes                     | Used for                      |
| --------------- | ------ | -------------------------- | ----------------------------- |
| `token`         | `t-1`  | read, write, audit         | almost everything             |
| `tokenReadOnly` | `t-1`  | `capacity:read`            | 403 on writes                 |
| `tokenNoAudit`  | `t-1`  | `capacity:read` + `:write` | 403 on ledger                 |
| `tokenTenant2`  | `t-2`  | read, write, audit         | tenant isolation              |
| `tokenExpired`  | `t-1`  | read, write, audit         | 401 (expired two minutes ago) |

## Files

| File                               | What it shows                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `01-reservation-lifecycle.http`    | Reserve €100k in a USD program → replay → partial release → final release → capacity is back |
| `02-multi-currency-and-lists.http` | GBP→EUR and USD→JPY reservations, keyset pagination, status filter, live SSE stream          |
| `03-audit-and-reconciliation.http` | Ledger and reconciliation discrepancies (`capacity:audit`)                                   |
| `04-errors.http`                   | The common error codes: capacity, conflicts, idempotency, currency, validation, not found    |
| `05-auth-and-tenancy.http`         | 401/403, tenant isolation (404 not 403), correlation-id echo                                 |
| `06-management.http`               | Health, readiness, Prometheus metrics, OpenAPI (internal port 9464, no auth)                 |

Each file can be run top to bottom any number of times: invoice ids and idempotency keys are generated per run, and
values such as `reservationId` are passed between requests through `client.global`. Requests that depend on an
earlier one say so in their title ("run 4 first").

Kafka messages can't be sent from the HTTP Client; use `npm run publish -- …` (see the main README), then look at
the results with `03-audit-and-reconciliation.http`.

## Running from the command line

The same files run headless with JetBrains' HTTP Client CLI, for example in Docker:

```bash
cd http
docker run --rm -v "$PWD":/workdir jetbrains/intellij-http-client \
  --env-file http-client.env.json --private-env-file http-client.private.env.json --env local \
  -D --report=reports *.http
```

`-D` makes `localhost` point at the host machine from inside the container.
