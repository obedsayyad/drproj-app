# apps/relief

Relief app: API (Express 5, node-postgres) and UI (React 19 + Vite, in `web/`). Phase 1 of docs/docs/11.

## Run

```
SUPABASE_APP_URL=... pnpm start:relief   # from repo root
SUPABASE_APP_URL=... pnpm seed           # 12 fixed demo records; safe to re-run; honors maintenance
pnpm --filter @drproj/relief build:web   # build the UI into web/dist; the API serves it at /
pnpm --filter @drproj/relief dev:web     # UI dev server; proxies /api and /health to RELIEF_API_ORIGIN (default http://127.0.0.1:8443)
```

## UI

- Same origin as the API (no CORS). Fonts are bundled (no external requests); the page CSP allows only `'self'`.
- Queue with need/urgency/status filters and "Show older requests" paging; form to log a request; detail panel with status buttons and history.
- "Answered by" shows the `X-Instance-Id` of the server that answered the last call (liveness ping every 5 s), so failover is visible during the demo.
- A form submission keeps one Idempotency-Key across retries until it succeeds or the form changes, so a retry after a timeout never logs twice.
- Maintenance (503) shows a banner; browsing keeps working.

## Configuration (environment)

| Variable | Default | Notes |
|---|---|---|
| `SUPABASE_APP_URL` | required | Login user in `dr_app_runtime`; session pooler (5432) |
| `APP_PORT` | 8443 | HTTPS when both TLS files are set; plaintext only for local dev (logged as a warning) |
| `APP_TLS_CERT_FILE`, `APP_TLS_KEY_FILE` | unset | Backend certificate from the project CA (docs/08) |
| `APP_METRICS_PORT` | 9464 | Diagnostics listener: `/metrics` only; not routed by HAProxy |
| `APP_DB_POOL_MAX` | 2 | Connections per instance; integer 1..5 (policy ceiling); other values make the app refuse to start. docs/03, docs/12 |
| `INSTANCE_ID`, `APP_VERSION` | `local`, `dev` | Sent as `X-Instance-Id` / `X-App-Version` on every response |
| `DEMO_MODE` | false | Enables `POST /api/demo/workload` |
| `DEMO_DEFAULT_WORK_MS`, `DEMO_MAX_WORK_MS`, `DEMO_MAX_CPU_WORKERS`, `DEMO_MAX_QUEUED_WORK_ITEMS` | 100, 250, 1, 32 | docs/03 `demo.*` |
| `MAINTENANCE_RETRY_AFTER_SECONDS` | 60 | |
| `IDEMPOTENCY_RETENTION_HOURS` | 24 | Expired completed keys purged every 10 min (skipped during maintenance) |
| `RATE_LIMIT_EXEMPT_IPS` | empty | Test (k6) host IP(s) |
| `TRUSTED_PROXY_IPS` | empty | HAProxy IP; only then is `X-Forwarded-For` used for the client IP |
| `RATE_LIMITS_ENABLED` | true | Per-IP: 50/10 s general, 20/10 s writes, 5/10 s demo |
| `APP_WEB_DIR` | `web/dist` | Built UI; skipped if it has no index.html |

## Behaviour decided in implementation

- Writes run in one transaction: maintenance check (fail closed), idempotency claim (`lock_timeout` 2 s), business write, stored result.
- Every write path checks maintenance, whatever Host or address was used. The flag is never cached; it is read `FOR SHARE` (`ops.app_admit_write()`), so a flip drains in-flight writes, and `/health/ready` reports `maintenance_generation`.
- `/health/live` needs no database and has no rate limit. `/health/ready` checks the database, control state and that app migration `0002_runtime_readiness_grant.sql` is applied.
- Problem codes added beyond the contracts: `VALIDATION_FAILED`, `NOT_FOUND`, `VERSION_CONFLICT`, `INVALID_STATUS_TRANSITION`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `WORK_QUEUE_FULL`, `DEMO_MODE_DISABLED`, `SCHEMA_INCOMPATIBLE`, `INTERNAL_ERROR`.
- Demo workload when `DEMO_MODE` is off: 503 `DEMO_MODE_DISABLED`. Queue full: 503 `WORK_QUEUE_FULL`, `Retry-After: 1`.
- Failed business checks (404/409/422) roll back, so the key is not stored and a corrected retry works.
- History rows use `source = relief_api` (`relief_api:seed` for seed data); creation adds a `null -> pending` row.
- Error responses never include internal error text (it can contain connection details).
