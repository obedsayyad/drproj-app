# drproj-app

Relief app repository (`obedsayyad/drproj-app`): pnpm workspace (Node 22+, TypeScript strict, Vitest). `docs/` is the `drproj-docs` bundle (git submodule; a local symlink to `../drproj-docs` until the repos are pushed).
Packages: `apps/relief` (relief API + UI), `packages/contracts`, `database/migrations` (all migrations, ops and app), `tests/integration`. The management API and dashboard live in `drproj-mgmt`.

## Commands (repo root)

| Command | Purpose |
|---|---|
| `pnpm install` | install (pnpm 10.30.3) |
| `pnpm gen:api` | regenerate `packages/contracts/src/generated/openapi.ts` from `docs/spec/openapi.yaml` |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | unit tests (contracts, migration planner, relief) |
| `pnpm test:integration` | real-Postgres migration and relief (T02, T19, T25) tests; needs `TEST_DATABASE_URL`, skipped otherwise |
| `pnpm start:relief` | run the relief API (env in `apps/relief/README.md`) |
| `pnpm build:web` | build the relief UI into `apps/relief/web/dist` |
| `pnpm seed` | insert deterministic demo data via `SUPABASE_APP_URL` |
| `pnpm migrate` | apply ops then app migrations using `SUPABASE_MIGRATION_URL` (session pooler) |
| `pnpm --filter @drproj/migrations exec tsx src/cli.ts --database-url-env TEST_DATABASE_URL` | migrate a different database |

Single test file / single test:

```
pnpm vitest run packages/contracts/src/relief.test.ts
pnpm vitest run packages/contracts/src/relief.test.ts -t "quantity"
```

Local integration database (disposable, loopback only; pick any password):

```
docker run --rm -d --name drproj-pg-test -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD="$PW" postgres:17-alpine
TEST_DATABASE_URL="postgres://postgres:$PW@127.0.0.1:55432/postgres" pnpm test:integration
docker stop drproj-pg-test
```

Environment variable names are in `.env.example` (no values). See `database/README.md` for the schema/role model.
`typescript` is pinned to 5.9.x because `openapi-typescript` needs the JS compiler API (absent in TS 7).

## Compose stacks (Phase 3.1)

- `deploy/compose/app` (relief + node_exporter with TLS/basic-auth web config) and `deploy/compose/lb` (HAProxy fail-closed placeholder + acme.sh skeleton; real config is Phase 6). Names-only `.env.example` in each.
- `apps/relief/Dockerfile` (build from this repo root; local tag only, nothing is published).
- Migration `ops/0007_keepalive_runs.sql` stores the Supabase keep-alive history.
