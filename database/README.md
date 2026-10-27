# database

`migrations/sql/ops` — management/control schema (`ops`), tracked in `ops.schema_migrations`. Never touched by app restores.
`migrations/sql/app` — recoverable business schema (`app`), tracked in `app.schema_migrations`, which travels inside backups.
After a live restore (schema swap, docs/09) re-run the migrator: only app migrations newer than the backup are applied.

Run order: ops then app. Applied files are checksummed; editing one aborts the run (add a new file instead).
The runner uses one connection, a session advisory lock and no prepared statements (Supabase session pooler, port 5432).

Roles are NOLOGIN groups: `dr_app_runtime`, `dr_ops`, `dr_backup`, `dr_restore`, `dr_automation` (ops/0009). Create login users and passwords out-of-band and grant a group. The management API login gets `dr_ops` only; the StackStorm login gets `dr_ops` and `dr_automation`, and capacity tables are writable only through the `ops.*` functions of ops/0009.
The app runtime reads maintenance only through `ops.app_maintenance_state()`; it has no table access to `ops`.
