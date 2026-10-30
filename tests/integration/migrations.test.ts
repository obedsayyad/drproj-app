// REAL local Postgres (TEST_DATABASE_URL), not Supabase and not a simulation.
// Skipped when TEST_DATABASE_URL is unset.
import { cp, mkdtemp, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@drproj/migrations';

const url = process.env['TEST_DATABASE_URL'];
const sqlDir = fileURLToPath(new URL('../../database/migrations/sql', import.meta.url));

describe.skipIf(!url)('migrations (real Postgres)', () => {
  let admin: pg.Client;
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await q('DROP SCHEMA IF EXISTS app CASCADE');
    await q('DROP SCHEMA IF EXISTS ops CASCADE');
  });
  afterAll(async () => {
    await admin.end();
  });

  it('applies both tracks on a fresh database, then is a no-op', async () => {
    const first = await runMigrations({ connectionString: url! });
    expect(first.applied).toEqual(['ops/0001_roles.sql', 'ops/0002_ops_schema.sql', 'ops/0003_ops_api.sql', 'ops/0004_maintenance_admission.sql', 'ops/0005_operation_event_envelope.sql', 'ops/0006_operation_idempotency_scope.sql', 'ops/0007_keepalive_runs.sql', 'ops/0008_processed_events_source.sql', 'ops/0009_capacity_control.sql', 'ops/0010_lease_takeover_attempt_grants.sql', 'ops/0011_provisioning_intents.sql', 'ops/0012_reconcile_failover.sql', 'ops/0013_standby_policy.sql', 'ops/0014_register_fixed_instance.sql', 'ops/0015_haproxy_routing.sql', 'ops/0016_haproxy_command_intent.sql', 'ops/0017_test_run_projection.sql', 'ops/0018_record_instance_deploy.sql', 'app/0001_app_schema.sql', 'app/0002_runtime_readiness_grant.sql']);
    expect((await runMigrations({ connectionString: url! })).applied).toEqual([]);
  });

  it('serializes concurrent runners', async () => {
    await q('DROP SCHEMA app CASCADE');
    await q('DROP SCHEMA ops CASCADE');
    const results = await Promise.all([1, 2, 3].map(() => runMigrations({ connectionString: url! })));
    expect(results.flatMap((r) => r.applied)).toHaveLength(20);
  });

  it('aborts when an applied migration was modified', async () => {
    const copy = join(await mkdtemp(join(tmpdir(), 'sql-')), 'sql');
    await cp(sqlDir, copy, { recursive: true });
    await appendFile(join(copy, 'app', '0001_app_schema.sql'), '\n-- tampered\n');
    await expect(runMigrations({ connectionString: url!, sqlDir: copy })).rejects.toThrow(/modified/);
  });

  it('constrains processed_events source and event_name (ops/0008)', async () => {
    const cols = (await q(`SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'ops' AND table_name = 'processed_events' AND column_name IN ('source', 'event_name')`)).rows;
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(byName.source.is_nullable).toBe('NO');
    expect(byName.source.column_default).toMatch(/alertmanager/);
    expect(byName.event_name.is_nullable).toBe('YES');
    const ins = (source: string, name: string | null, fp: string) =>
      q(`INSERT INTO ops.processed_events (fingerprint, policy_version, source, event_name) VALUES ($1, 1, $2, $3)`, [fp, source, name]);
    await expect(ins('bogus', 'x', 'fp-bad-source')).rejects.toThrow(/check/i);
    await expect(ins('alertmanager', 'x'.repeat(101), 'fp-long-name')).rejects.toThrow(/check/i);
    await expect(q(`INSERT INTO ops.processed_events (fingerprint, policy_version, source) VALUES ('fp-null-source', 1, NULL)`)).rejects.toThrow(/not-null|null value/i);
    await ins('timer', 'x'.repeat(100), 'fp-ok');
    await q(`INSERT INTO ops.processed_events (fingerprint, policy_version) VALUES ('fp-default', 1)`);
    expect((await q(`SELECT source FROM ops.processed_events WHERE fingerprint = 'fp-default'`)).rows[0].source).toBe('alertmanager');
  });

  it('enforces quantity, key and routing invariants in the database', async () => {
    const ins = (qty: number) =>
      q(`INSERT INTO app.relief_requests (resource_type, quantity, location, urgency) VALUES ('food', $1, 'x', 'low')`, [qty]);
    await expect(ins(10001)).rejects.toThrow(/check/i);
    await expect(ins(0)).rejects.toThrow(/check/i);
    await ins(10000);
    await expect(
      q(`INSERT INTO app.idempotency_records (key, method, route_template, request_hash, expires_at)
         VALUES ('short', 'POST', '/api/requests', 'h', now())`),
    ).rejects.toThrow(/check/i);
    await expect(
      q(`INSERT INTO ops.instances (provider, role, lifecycle_state, routing_mode, slot_key)
         VALUES ('self_hosted', 'primary', 'provisioning', 'active', NULL)`),
    ).rejects.toThrow(/active_requires_ready/);
  });

  it('keeps a single runtime_flags row and exposes maintenance only via the function', async () => {
    expect((await q('SELECT count(*)::int AS n FROM ops.runtime_flags')).rows[0].n).toBe(1);
    await expect(q('INSERT INTO ops.runtime_flags (singleton) VALUES (false)')).rejects.toThrow();
    await q('BEGIN');
    try {
      await q('SET LOCAL ROLE dr_app_runtime');
      const state = await q('SELECT maintenance FROM ops.app_maintenance_state()');
      expect(state.rows[0].maintenance).toBe(false);
      await q('SAVEPOINT s');
      await expect(q('SELECT * FROM ops.runtime_flags')).rejects.toThrow(/permission denied/);
      await q('ROLLBACK TO s');
    } finally {
      await q('ROLLBACK');
    }
  });

  it('lets dr_ops append and read keep-alive history but not rewrite it', async () => {
    await q('BEGIN');
    try {
      await q('SET LOCAL ROLE dr_ops');
      await q(`INSERT INTO ops.keepalive_runs (succeeded, detail) VALUES (true, NULL)`);
      expect((await q('SELECT count(*)::int AS n FROM ops.keepalive_runs WHERE succeeded')).rows[0].n).toBe(1);
      await q('SAVEPOINT s');
      await expect(q('DELETE FROM ops.keepalive_runs')).rejects.toThrow(/permission denied/);
      await q('ROLLBACK TO s');
      await expect(q(`INSERT INTO ops.keepalive_runs (succeeded, detail) VALUES (false, repeat('x', 201))`)).rejects.toThrow(/check/i);
    } finally {
      await q('ROLLBACK');
    }
  });

  it('records a deploy for dr_automation only, idempotently, with an audit row (ops/0018)', async () => {
    const d1 = 'sha256:' + 'a'.repeat(64);
    const d2 = 'sha256:' + 'b'.repeat(64);
    const id = (await q(`INSERT INTO ops.instances (provider, provider_resource_id, role, image_digest, lifecycle_state)
      VALUES ('self_hosted', 'rid-0018', 'primary', $1, 'ready') RETURNING id`, [d1])).rows[0].id;
    const asRole = async (role: string, fn: () => Promise<void>) => {
      await q('BEGIN');
      try { await q(`SET LOCAL ROLE ${role}`); await fn(); } finally { await q('ROLLBACK'); }
    };
    await asRole('dr_ops', async () => {
      await expect(q('SELECT ops.record_instance_deploy($1, $2, $3, $4)', [id, d2, '1.0.0', 'rev-1'])).rejects.toThrow(/permission denied/);
    });
    await q('BEGIN');
    await q('SET LOCAL ROLE dr_automation');
    await q('SELECT ops.record_instance_deploy($1, $2, $3, $4)', [id, d2, '1.0.0', 'rev-1']);
    await q('SELECT ops.record_instance_deploy($1, $2, $3, $4)', [id, d2, '1.0.0', 'rev-1']);
    await q('SAVEPOINT s');
    await expect(q('SELECT ops.record_instance_deploy($1, $2, $3, $4)', [id, 'sha256:xyz', '1.0.0', 'rev-1'])).rejects.toThrow(/bad_argument/);
    await q('ROLLBACK TO s');
    await expect(q('SELECT ops.record_instance_deploy($1, $2, $3, $4)', ['00000000-0000-0000-0000-000000000000', d2, '1.0.0', 'rev-1'])).rejects.toThrow(/unknown_instance/);
    await q('ROLLBACK TO s');
    await q('RESET ROLE');
    const row = (await q('SELECT image_digest, configuration_revision, last_seen_at IS NOT NULL AS seen FROM ops.instances WHERE id = $1', [id])).rows[0];
    expect(row).toEqual({ image_digest: d2, configuration_revision: 'rev-1', seen: true });
    const audit = (await q(`SELECT old_value, new_value FROM ops.audit_events WHERE action = 'instance.deploy_recorded' AND object = $1 ORDER BY occurred_at, id`, ['instance:' + id])).rows;
    expect(audit).toHaveLength(2);
    expect(audit[0].old_value.image_digest).toBe(d1);
    expect(audit[1].new_value).toMatchObject({ image_digest: d2, app_version: '1.0.0' });
    await q('ROLLBACK');
    await q('DELETE FROM ops.instances WHERE id = $1', [id]);
  });

  it('re-applies only the app track after the app schema is replaced; ops data survives', async () => {
    await q(`UPDATE ops.runtime_flags SET maintenance = true, generation = 7`);
    await q('DROP SCHEMA app CASCADE');
    expect((await runMigrations({ connectionString: url! })).applied).toEqual(['app/0001_app_schema.sql', 'app/0002_runtime_readiness_grant.sql']);
    const flags = (await q('SELECT maintenance, generation::int AS g FROM ops.runtime_flags')).rows[0];
    expect(flags).toEqual({ maintenance: true, g: 7 });
  });
});
