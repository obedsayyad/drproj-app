// REAL local Postgres (TEST_DATABASE_URL), not Supabase and not a simulation. Skipped when it is unset.
// Contract tests for ops/0009: lease fencing, slot reservation/caps, release evidence, attempts, operation projection.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '@drproj/migrations';

const url = process.env['TEST_DATABASE_URL'];
const policyDefaults = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/config/policy-defaults.json', import.meta.url)), 'utf8'));
const eventTypes: string[] = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/spec/events.schema.json', import.meta.url)), 'utf8')).properties.event_type.enum;

const EVIDENCE_ABSENT = { confirmed_absent: true, source: 'provider_api', observed_at: '2026-01-01T00:00:00Z' };
const EVIDENCE_PRESENT = { exists: true, source: 'provider_api', observed_at: '2026-01-01T00:00:00Z' };

describe.skipIf(!url)('capacity control (real Postgres, ops/0009)', () => {
  let admin: pg.Client;
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);
  const one = async (sql: string, params?: unknown[]) => (await q(sql, params)).rows[0];
  /** SQLSTATE of the failure, or 'ok'. */
  const code = async (sql: string, params?: unknown[]) => {
    try {
      await admin.query(sql, params);
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? 'unknown';
    }
  };

  const newOp = async (kind = 'scale_out', status = 'running') =>
    (await one(`INSERT INTO ops.operations (kind, policy_version, status) VALUES ($1, 1, $2) RETURNING id`, [kind, status])).id as string;
  const lease = async (op: string) => Number((await one(`SELECT generation FROM ops.acquire_lease($1)`, [op])).generation);
  /** A fresh operation that holds the lease. */
  const owner = async (kind = 'scale_out') => {
    await q(`UPDATE ops.control_leases SET holder_operation = NULL, lease_expires_at = NULL`);
    const op = await newOp(kind);
    return { op, gen: await lease(op) };
  };
  const reserve = async (o: { op: string; gen: number }, provider: string, kind = 'elastic') =>
    (await q(`SELECT * FROM ops.reserve_slot($1, $2, $3, $4, true)`, [o.op, o.gen, provider, kind])).rows[0] as
      | { reserved_key: string; reserved_generation: string; reserved_instance_id: string; replayed: boolean }
      | undefined;
  const setCaps = async (digitalocean: number, linode: number) => {
    const cfg = structuredClone(policyDefaults);
    cfg.capacity.max_cloud_vms_per_provider = { digitalocean, linode };
    await q(`UPDATE ops.policy_versions SET configuration = $1 WHERE version = 1`, [JSON.stringify(cfg)]);
  };
  const bindOk = async (o: { op: string; gen: number }, key: string, slotGen: number, rid: string) =>
    q(`SELECT ops.bind_slot($1, $2, $3, $4, $5, '198.51.100.7', 1, 1024)`, [o.op, o.gen, key, slotGen, rid]);
  const occupied = async (provider: string) => Number((await one(`SELECT count(*) FROM ops.capacity_slots WHERE provider = $1 AND state <> 'free'`, [provider])).count);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await q('DROP SCHEMA IF EXISTS app CASCADE');
    await q('DROP SCHEMA IF EXISTS ops CASCADE');
    await runMigrations({ connectionString: url! });
  });
  afterAll(async () => {
    await admin.end();
  });
  beforeEach(async () => {
    await q(`DELETE FROM ops.audit_events`);
    await q(`DELETE FROM ops.operation_events`);
    await q(`DELETE FROM ops.operation_attempts`);
    await q(`UPDATE ops.capacity_slots SET state = 'free', bound_instance_id = NULL, lease_operation_id = NULL`);
    await q(`DELETE FROM ops.instances`);
    await q(`UPDATE ops.control_leases SET holder_operation = NULL, lease_expires_at = NULL`);
    await q(`DELETE FROM ops.incident_events`);
    await q(`DELETE FROM ops.incidents`);
    await q(`DELETE FROM ops.processed_events`);
    await q(`DELETE FROM ops.operations`);
    await q(`DELETE FROM ops.policy_versions`);
    await q(`UPDATE ops.runtime_flags SET maintenance = false, metrics_stale_since = NULL`);
    await q(`INSERT INTO ops.policy_versions (version, configuration, status, activation_phase) VALUES (1, $1, 'active', 'completed')`, [JSON.stringify(policyDefaults)]);
  });

  it('seeds one slot per possible VM and the application lease row', async () => {
    const slots = (await q(`SELECT key, provider, role, state FROM ops.capacity_slots ORDER BY key`)).rows;
    expect(slots).toHaveLength(13);
    expect(slots.every((s) => s.state === 'free')).toBe(true);
    expect(slots.filter((s) => s.provider === 'digitalocean')).toHaveLength(7); // 5 elastic + warm + interim
    expect((await q(`SELECT 1 FROM ops.control_leases WHERE application_key = 'relief'`)).rowCount).toBe(1);
  });

  describe('lease and fencing', () => {
    it('grants one live holder, fences an old worker after expiry, and refuses stale renew/assert', async () => {
      const a = await newOp();
      const b = await newOp();
      const genA = await lease(a);
      expect((await q(`SELECT * FROM ops.acquire_lease($1)`, [b])).rowCount).toBe(0); // live lease held by a
      await q(`SELECT ops.assert_lease($1, $2)`, [a, genA]);
      expect(await code(`SELECT ops.assert_lease($1, $2)`, [b, genA])).toBe('CDR01');
      expect(await code(`SELECT ops.assert_lease($1, $2)`, [a, genA + 1])).toBe('CDR01');
      expect(await one(`SELECT generation FROM ops.acquire_lease($1)`, [a])).toMatchObject({ generation: String(genA) }); // re-entrant, same generation

      await q(`UPDATE ops.control_leases SET lease_expires_at = now() - interval '1 second'`);
      expect(await code(`SELECT * FROM ops.acquire_lease($1)`, [b])).toBe('CDR02'); // scale_out may not take over an expired lease (docs/07)
      expect(await one(`SELECT holder_operation, fencing_generation FROM ops.control_leases`)).toMatchObject({ holder_operation: a, fencing_generation: String(genA) });
      const r = await newOp('reconcile');
      const taken = await one(`SELECT * FROM ops.acquire_lease($1)`, [r]);
      expect(Number(taken.generation)).toBe(genA + 1);
      expect(taken).toMatchObject({ previous_holder: a, previous_expired: true });
      expect(await code(`SELECT ops.assert_lease($1, $2)`, [a, genA])).toBe('CDR01'); // old worker is fenced
      expect(await code(`SELECT ops.renew_lease($1, $2)`, [a, genA])).toBe('CDR01');
      await q(`SELECT ops.renew_lease($1, $2)`, [r, genA + 1]);
      expect((await one(`SELECT ops.release_lease($1, $2) AS r`, [a, genA])).r).toBe(false);
      expect((await one(`SELECT ops.release_lease($1, $2) AS r`, [r, genA + 1])).r).toBe(true);
    });

    it('only one of many concurrent acquirers wins', async () => {
      const ops: string[] = [];
      for (let i = 0; i < 6; i++) ops.push(await newOp());
      const clients = await Promise.all(ops.map(async () => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; }));
      try {
        const results = await Promise.all(clients.map((c, i) => c.query(`SELECT * FROM ops.acquire_lease($1)`, [ops[i]])));
        expect(results.filter((r) => r.rowCount === 1)).toHaveLength(1);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });

    it('refuses a terminal or unknown operation and an out-of-range ttl', async () => {
      const done = await newOp('scale_out', 'succeeded');
      expect(await code(`SELECT * FROM ops.acquire_lease($1)`, [done])).toBe('CDR04');
      expect(await code(`SELECT * FROM ops.acquire_lease($1)`, ['00000000-0000-4000-8000-000000000000'])).toBe('CDR04');
      expect(await code(`SELECT * FROM ops.acquire_lease($1, 'relief', 5)`, [await newOp()])).toBe('CDR04');
    });
  });

  describe('slot reservation and caps', () => {
    it('requires the live lease', async () => {
      const o = await owner();
      await q(`UPDATE ops.control_leases SET lease_expires_at = now() - interval '1 second'`);
      expect(await code(`SELECT * FROM ops.reserve_slot($1, $2, 'digitalocean', 'elastic')`, [o.op, o.gen])).toBe('CDR01');
      expect(await occupied('digitalocean')).toBe(0);
    });

    it('counts reserved, held_uncertain and releasing toward the cap, keeps the warm place back, and never exceeds it', async () => {
      await setCaps(3, 5);
      const o = await owner();
      const first = (await reserve(o, 'digitalocean'))!;
      expect(first).toMatchObject({ reserved_key: 'elastic-do-1', replayed: false });
      // A second elastic slot for the same operation is refused, not silently added.
      expect(await code(`SELECT * FROM ops.reserve_slot($1, $2, 'linode', 'elastic')`, [o.op, o.gen])).toBe('CDR02');

      const o2 = await owner();
      expect((await reserve(o2, 'digitalocean'))?.reserved_key).toBe('elastic-do-2'); // 1 + 1 + warm floor = 3 = cap
      const o3 = await owner();
      expect(await reserve(o3, 'digitalocean')).toBeUndefined(); // third elastic would take the warm place
      const warm = await reserve(o3, 'digitalocean', 'warm');
      expect(warm?.reserved_key).toBe('warm');
      expect(await occupied('digitalocean')).toBe(3);

      // Uncertain and releasing slots still count: nothing frees capacity by itself.
      await q(`SELECT ops.mark_slot_uncertain($1, $2, 'elastic-do-1', $3, 'api timeout')`, [o3.op, o3.gen, first.reserved_generation]);
      await q(`UPDATE ops.capacity_slots SET state = 'releasing' WHERE key = 'elastic-do-2'`);
      expect(await occupied('digitalocean')).toBe(3);
      const o4 = await owner();
      expect(await reserve(o4, 'digitalocean')).toBeUndefined();
      expect(await reserve(o4, 'linode')).toMatchObject({ reserved_key: 'elastic-linode-1' });
    });

    it('fails closed with no active policy, and the table ceiling rejects a sixth occupied slot per provider', async () => {
      await q(`DELETE FROM ops.policy_versions`);
      const o = await owner();
      expect(await reserve(o, 'linode')).toBeUndefined();
      await q(`INSERT INTO ops.policy_versions (version, configuration, status, activation_phase) VALUES (1, $1, 'active', 'completed')`, [JSON.stringify(policyDefaults)]);
      const rows = (await q(`SELECT key FROM ops.capacity_slots WHERE provider = 'linode' ORDER BY key`)).rows.map((r) => r.key as string);
      const mk = async (key: string) => {
        const id = (await one(`INSERT INTO ops.instances (slot_key, provider, role, lifecycle_state) VALUES ($1, 'linode', 'elastic', 'reserved') RETURNING id`, [key])).id;
        return code(`UPDATE ops.capacity_slots SET state = 'reserved', bound_instance_id = $2 WHERE key = $1`, [key, id]);
      };
      const results: string[] = [];
      for (const k of rows) results.push(await mk(k));
      expect(results.filter((r) => r === 'ok')).toHaveLength(5);
      expect(results.filter((r) => r === 'CDR02')).toHaveLength(rows.length - 5);
    });

    it('is replay-safe: concurrent identical reserve calls from one operation create exactly one slot', async () => {
      const o = await owner();
      const clients = await Promise.all([1, 2, 3, 4].map(async () => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; }));
      try {
        const res = await Promise.all(clients.map((c) => c.query(`SELECT * FROM ops.reserve_slot($1, $2, 'linode', 'elastic', true)`, [o.op, o.gen])));
        const keys = new Set(res.map((r) => r.rows[0].reserved_key));
        expect(keys.size).toBe(1);
        expect(res.filter((r) => r.rows[0].replayed === false)).toHaveLength(1);
        expect(await occupied('linode')).toBe(1);
        expect((await q(`SELECT 1 FROM ops.instances WHERE lifecycle_state = 'reserved'`)).rowCount).toBe(1);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });

    it('binds, then releases only through releasing with confirmed absence; a stale slot generation is refused', async () => {
      const o = await owner();
      const r = (await reserve(o, 'digitalocean'))!;
      const gen = Number(r.reserved_generation);
      expect(await code(`SELECT ops.bind_slot($1, $2, $3, $4, 'sim-1', NULL, 1, 1024)`, [o.op, o.gen, r.reserved_key, gen + 1])).toBe('CDR02');
      await bindOk(o, r.reserved_key, gen, 'sim-1');
      expect(await one(`SELECT lifecycle_state, simulated, provider_resource_id FROM ops.instances WHERE id = $1`, [r.reserved_instance_id])).toMatchObject({ lifecycle_state: 'provisioning', simulated: true, provider_resource_id: 'sim-1' });

      expect(await code(`SELECT ops.release_slot($1, $2, $3, $4, $5)`, [o.op, o.gen, r.reserved_key, gen, EVIDENCE_ABSENT])).toBe('CDR02'); // not releasing yet
      await q(`SELECT ops.begin_slot_release($1, $2, $3, $4)`, [o.op, o.gen, r.reserved_key, gen]);
      for (const bad of [{ confirmed_absent: false, source: 'provider_api', observed_at: '2026-01-01T00:00:00Z' }, { confirmed_absent: true, source: 'timeout', observed_at: '2026-01-01T00:00:00Z' }, { confirmed_absent: true, source: 'provider_api' }, null]) {
        expect(await code(`SELECT ops.release_slot($1, $2, $3, $4, $5)`, [o.op, o.gen, r.reserved_key, gen, bad === null ? null : JSON.stringify(bad)])).toBe('CDR04');
      }
      expect(await occupied('digitalocean')).toBe(1);
      await q(`SELECT ops.release_slot($1, $2, $3, $4, $5)`, [o.op, o.gen, r.reserved_key, gen, JSON.stringify(EVIDENCE_ABSENT)]);
      expect(await occupied('digitalocean')).toBe(0);
      expect(await one(`SELECT lifecycle_state FROM ops.instances WHERE id = $1`, [r.reserved_instance_id])).toMatchObject({ lifecycle_state: 'deleted' });
      expect(Number((await one(`SELECT count(*) FROM ops.audit_events WHERE action = 'slot.released' AND operation_id = $1`, [o.op])).count)).toBe(1);
    });

    it('chooses providers alternately, non-warm first, skipping a provider at cap or listed unavailable; scale-in picks the newest elastic', async () => {
      expect((await one(`SELECT ops.next_elastic_provider() AS p`)).p).toBe('linode'); // warm provider is digitalocean
      const picks: string[] = [];
      const placed: string[] = [];
      for (let i = 0; i < 4; i++) {
        const o = await owner();
        const p = (await one(`SELECT ops.next_elastic_provider() AS p`)).p as string;
        picks.push(p);
        const r = (await reserve(o, p))!;
        await bindOk(o, r.reserved_key, Number(r.reserved_generation), `sim-${i}`);
        await q(`UPDATE ops.instances SET created_at = now() + ($2 || ' seconds')::interval WHERE id = $1`, [r.reserved_instance_id, String(i)]);
        placed.push(r.reserved_key);
      }
      expect(picks).toEqual(['linode', 'digitalocean', 'linode', 'digitalocean']);
      expect((await one(`SELECT ops.scale_in_candidate() AS k`)).k).toBe(placed[3]); // newest first
      expect((await one(`SELECT ops.next_elastic_provider(ARRAY['linode']) AS p`)).p).toBe('digitalocean');
      expect((await one(`SELECT ops.next_elastic_provider(ARRAY['linode','digitalocean']) AS p`)).p).toBeNull();
      await setCaps(2, 2); // linode: 2 occupied = cap
      expect((await one(`SELECT ops.next_elastic_provider() AS p`)).p).toBeNull(); // digitalocean: 2 + warm floor > cap
      await setCaps(4, 2);
      expect((await one(`SELECT ops.next_elastic_provider() AS p`)).p).toBe('digitalocean');
    });
  });

  describe('warm standby slots (T27, T36 data rules)', () => {
    const bindWarm = async (o: { op: string; gen: number }, provider: string, kind: 'warm' | 'interim_warm', rid: string) => {
      const r = (await reserve(o, provider, kind))!;
      await bindOk(o, r.reserved_key, Number(r.reserved_generation), rid);
      return r;
    };

    it('protects the warm slot from scale_in, but a scale_in may release the surplus warm after reconcile resolves', async () => {
      const w = await owner('standby_repair');
      const warm = await bindWarm(w, 'digitalocean', 'warm', 'sim-w');
      const si = await owner('scale_in');
      expect(await code(`SELECT ops.begin_slot_release($1, $2, 'warm', $3)`, [si.op, si.gen, warm.reserved_generation])).toBe('CDR02');
      expect((await one(`SELECT ops.scale_in_candidate() AS k`)).k).toBeNull();

      // T36: warm provider unknown -> interim warm on the other provider; both providers count one slot each.
      const rep = await owner('standby_repair');
      await q(`SELECT ops.mark_slot_uncertain($1, $2, 'warm', $3, 'provider API unknown')`, [rep.op, rep.gen, warm.reserved_generation]);
      expect(await reserve(rep, 'digitalocean', 'interim_warm')).toBeUndefined(); // must be the other provider
      const interim = (await reserve(rep, 'linode', 'interim_warm'))!;
      expect(interim.reserved_key).toBe('interim-warm-linode');
      await bindOk(rep, interim.reserved_key, Number(interim.reserved_generation), 'sim-i');
      expect([await occupied('digitalocean'), await occupied('linode')]).toEqual([1, 1]);

      // Only reconcile resolves a held slot, and only with evidence.
      expect(await code(`SELECT ops.resolve_held_slot($1, $2, 'warm', $3, 'free', $4)`, [rep.op, rep.gen, warm.reserved_generation, JSON.stringify(EVIDENCE_ABSENT)])).toBe('CDR02');
      const rec = await owner('reconcile');
      expect(await code(`SELECT ops.resolve_held_slot($1, $2, 'warm', $3, 'free', $4)`, [rec.op, rec.gen, warm.reserved_generation, JSON.stringify(EVIDENCE_PRESENT)])).toBe('CDR04');
      expect(await code(`SELECT ops.resolve_held_slot($1, $2, 'warm', $3, 'bound', $4)`, [rec.op, rec.gen, warm.reserved_generation, JSON.stringify(EVIDENCE_ABSENT)])).toBe('CDR04');
      await q(`SELECT ops.resolve_held_slot($1, $2, 'warm', $3, 'bound', $4, 'sim-w', NULL)`, [rec.op, rec.gen, warm.reserved_generation, JSON.stringify(EVIDENCE_PRESENT)]);
      expect(await one(`SELECT state FROM ops.capacity_slots WHERE key = 'warm'`)).toMatchObject({ state: 'bound' });

      // Two warm-role slots are bound; scale_in may now drain the surplus (interim) one, and then never the last.
      const si2 = await owner('scale_in');
      await q(`SELECT ops.begin_slot_release($1, $2, 'interim-warm-linode', $3)`, [si2.op, si2.gen, interim.reserved_generation]);
      await q(`SELECT ops.release_slot($1, $2, 'interim-warm-linode', $3, $4)`, [si2.op, si2.gen, interim.reserved_generation, JSON.stringify(EVIDENCE_ABSENT)]);
      expect((await q(`SELECT 1 FROM ops.capacity_slots WHERE role = 'warm' AND state = 'bound'`)).rowCount).toBe(1);
      const si3 = await owner('scale_in');
      expect(await code(`SELECT ops.begin_slot_release($1, $2, 'warm', $3)`, [si3.op, si3.gen, warm.reserved_generation])).toBe('CDR02');
    });

    it('lets reconcile free a held slot only on confirmed absence', async () => {
      const o = await owner();
      const r = (await reserve(o, 'linode'))!;
      await q(`SELECT ops.mark_slot_uncertain($1, $2, $3, $4, 'create timed out')`, [o.op, o.gen, r.reserved_key, r.reserved_generation]);
      const rec = await owner('reconcile');
      await q(`SELECT ops.resolve_held_slot($1, $2, $3, $4, 'free', $5)`, [rec.op, rec.gen, r.reserved_key, r.reserved_generation, JSON.stringify(EVIDENCE_ABSENT)]);
      expect(await occupied('linode')).toBe(0);
    });
  });

  describe('standby surplus and policy apply (ops/0013)', () => {
    it('names the interim warm slot as the scale-in candidate only while the original warm slot is bound and ready', async () => {
      const w = await owner('standby_repair');
      const warm = await reserve(w, 'digitalocean', 'warm');
      await bindOk(w, warm!.reserved_key, Number(warm!.reserved_generation), 'sim-w');
      await q(`SELECT ops.set_instance_state($1, $2, 'warm', $3, 'ready')`, [w.op, w.gen, warm!.reserved_generation]);
      const el = await owner();
      const e = (await reserve(el, 'linode'))!;
      await bindOk(el, e.reserved_key, Number(e.reserved_generation), 'sim-e');
      expect((await one(`SELECT ops.scale_in_candidate() AS k`)).k).toBe(e.reserved_key);
      // interim bound next to a ready warm: the interim is the surplus
      await q(`UPDATE ops.capacity_slots SET state = 'held_uncertain' WHERE key = 'warm'`);
      const it2 = await owner('standby_repair');
      const interim = (await reserve(it2, 'linode', 'interim_warm'))!;
      await bindOk(it2, interim.reserved_key, Number(interim.reserved_generation), 'sim-i');
      expect((await one(`SELECT ops.scale_in_candidate() AS k`)).k).toBe(e.reserved_key); // warm still uncertain: interim is not surplus
      await q(`UPDATE ops.capacity_slots SET state = 'bound' WHERE key = 'warm'`);
      expect((await one(`SELECT ops.scale_in_candidate() AS k`)).k).toBe('interim-warm-linode');
    });

    it('lets standby_repair or reconcile, and nobody else, record the state of a warm slot another operation provisioned', async () => {
      const w = await owner('standby_repair');
      const warm = (await reserve(w, 'digitalocean', 'warm'))!;
      await bindOk(w, warm.reserved_key, Number(warm.reserved_generation), 'sim-w');
      const rep = await owner('standby_repair');
      await q(`SELECT ops.set_instance_state($1, $2, 'warm', $3, 'ready', 'on', 'sha256:a')`, [rep.op, rep.gen, warm.reserved_generation]);
      expect(await one(`SELECT lifecycle_state, image_digest FROM ops.instances WHERE slot_key = 'warm'`)).toMatchObject({ lifecycle_state: 'ready', image_digest: 'sha256:a' });
      const so = await owner('scale_out');
      expect(await code(`SELECT ops.set_instance_state($1, $2, 'warm', $3, 'failed')`, [so.op, so.gen, warm.reserved_generation])).toBe('CDR02');
      const eo = await owner('scale_out');
      const el = (await reserve(eo, 'linode'))!;
      await bindOk(eo, el.reserved_key, Number(el.reserved_generation), 'sim-e');
      const rep2 = await owner('standby_repair');
      expect(await code(`SELECT ops.set_instance_state($1, $2, $3, $4, 'failed')`, [rep2.op, rep2.gen, el.reserved_key, el.reserved_generation])).toBe('CDR02'); // elastic slot: owner only
    });

    const pendingOp = async (version: number) => {
      const cfg = structuredClone(policyDefaults);
      cfg.capacity.max_cloud_vms_per_provider = { digitalocean: 4, linode: 5 };
      await q(`INSERT INTO ops.policy_versions (version, configuration, status, activation_phase) VALUES ($1, $2, 'pending', 'validating')`, [version, JSON.stringify(cfg)]);
      return (await one(`INSERT INTO ops.operations (kind, policy_version, status, parameters) VALUES ('apply_policy', 1, 'running', $1) RETURNING id`, [JSON.stringify({ policy_version: version })])).id as string;
    };

    it('moves the pending version through its phases only for its own apply_policy operation, and a failure keeps the old version active', async () => {
      const op = await pendingOp(2);
      const other = await newOp('apply_policy');
      expect(await code(`SELECT ops.set_policy_phase($1, 2, 'compiling')`, [other])).toBe('CDR02');
      expect(await code(`SELECT ops.set_policy_phase($1, 2, 'completed')`, [op])).toBe('CDR04');
      await q(`SELECT ops.set_policy_phase($1, 2, 'verifying')`, [op]);
      expect(await one(`SELECT activation_phase FROM ops.policy_versions WHERE version = 2`)).toMatchObject({ activation_phase: 'verifying' });
      expect(await one(`SELECT ops.finish_policy_apply($1, 2, false, '{"error":"x"}') AS r`, [op])).toMatchObject({ r: 'failed' });
      expect(await one(`SELECT version FROM ops.policy_versions WHERE status = 'active'`)).toMatchObject({ version: 1 });
      expect(await code(`SELECT ops.set_policy_phase($1, 2, 'applying')`, [op])).toBe('CDR03'); // no longer pending
    });

    it('activates the pending version and supersedes the old one', async () => {
      const op = await pendingOp(2);
      expect(await one(`SELECT ops.finish_policy_apply($1, 2, true, '{"ok":true}') AS r`, [op])).toMatchObject({ r: 'active' });
      expect((await q(`SELECT version, status FROM ops.policy_versions ORDER BY version`)).rows).toEqual([{ version: 1, status: 'superseded' }, { version: 2, status: 'active' }]);
    });

    it('lets only reconcile fail the pending version of an interrupted apply_policy', async () => {
      const op = await pendingOp(2);
      const w = await owner('scale_out');
      expect(await code(`SELECT ops.fail_pending_policy($1, $2, $3, 'interrupted')`, [w.op, w.gen, op])).toBe('CDR02');
      const rec = await owner('reconcile');
      expect((await one(`SELECT ops.fail_pending_policy($1, $2, $3, 'interrupted') AS r`, [rec.op, rec.gen, op])).r).toBe(true);
      expect((await one(`SELECT ops.fail_pending_policy($1, $2, $3, 'interrupted') AS r`, [rec.op, rec.gen, op])).r).toBe(false);
      expect(await one(`SELECT status FROM ops.policy_versions WHERE version = 2`)).toMatchObject({ status: 'failed' });
    });
  });

  describe('attempts', () => {
    it('records an attempt once; a restart sees created=false and the same ids, deadline from the captured policy', async () => {
      const o = await owner();
      const r = (await reserve(o, 'digitalocean'))!;
      const args = [o.op, o.gen, 1, 'digitalocean', r.reserved_key, r.reserved_generation];
      const first = await one(`SELECT * FROM ops.start_attempt($1, $2, $3, $4, $5, $6)`, args);
      const again = await one(`SELECT * FROM ops.start_attempt($1, $2, $3, $4, $5, $6)`, args);
      expect(first.created).toBe(true);
      expect(again).toMatchObject({ created: false, attempt_id: first.attempt_id });
      const row = await one(`SELECT extract(epoch FROM deadline_at - started_at)::int AS d, extract(epoch FROM checkpoint_at - started_at)::int AS c FROM ops.operation_attempts WHERE operation_id = $1`, [o.op]);
      expect(row).toEqual({ d: policyDefaults.provisioning.readiness_deadline_seconds, c: policyDefaults.provisioning.readiness_checkpoints_seconds[0] });
      expect(await code(`SELECT * FROM ops.start_attempt($1, $2, 2, 'linode', $3, $4)`, [o.op, o.gen, r.reserved_key, r.reserved_generation])).toBe('CDR02'); // provider must match the slot

      await q(`SELECT ops.finish_attempt($1, $2, 1, 'failed', 'readiness_deadline')`, [o.op, o.gen]);
      await q(`SELECT ops.finish_attempt($1, $2, 1, 'cleaned')`, [o.op, o.gen]);
      expect(await code(`SELECT ops.finish_attempt($1, $2, 1, 'ready')`, [o.op, o.gen])).toBe('CDR03'); // cleaned is final
    });
  });

  describe('operation projection', () => {
    it('follows the docs/05 transition table, records events in order, and keeps terminal states final', async () => {
      const op = await newOp('scale_out', 'queued');
      const adv = (status: string | null, step: string, type = 'operation.step.completed', outcome: object | null = null) =>
        code(`SELECT ops.advance_operation($1, $2, $3, $4, 'm', $5)`, [op, status, step, type, outcome && JSON.stringify(outcome)]);
      expect(await adv('succeeded', 'x')).toBe('CDR03');
      expect(await adv('verifying', 'x')).toBe('CDR03');
      for (const [s, step] of [['running', 'a'], ['waiting', 'b'], ['running', 'c'], ['verifying', 'd'], ['succeeded', 'e']] as const) expect(await adv(s, step, s === 'succeeded' ? 'operation.succeeded' : undefined)).toBe('ok');
      expect(await adv('running', 'again')).toBe('CDR03');
      const row = await one(`SELECT status, current_step, finished_at IS NOT NULL AS done FROM ops.operations WHERE id = $1`, [op]);
      expect(row).toEqual({ status: 'succeeded', current_step: 'e', done: true });
      const seqs = (await q(`SELECT sequence FROM ops.operation_events WHERE operation_id = $1 ORDER BY sequence`, [op])).rows.map((r) => Number(r.sequence));
      expect(seqs).toHaveLength(5);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    });

    it('allows a terminal no-op only with a reason, forbids paused -> failed, and rejects unknown event types', async () => {
      const op = await newOp('scale_in', 'queued');
      expect(await code(`SELECT ops.advance_operation($1, 'succeeded', 'noop', 'operation.succeeded')`, [op])).toBe('CDR03');
      expect(await code(`SELECT ops.advance_operation($1, 'succeeded', 'noop', 'operation.succeeded', 'primary outage', $2)`, [op, JSON.stringify({ noop_reason: 'primary_outage' })])).toBe('ok');
      const p = await newOp('scale_out', 'paused');
      expect(await code(`SELECT ops.advance_operation($1, 'failed', 'x', 'operation.failed')`, [p])).toBe('CDR03');
      expect(await code(`SELECT ops.advance_operation($1, 'running', 'x', 'operation.nonsense')`, [p])).toBe('CDR04');
    });

    it('keeps the SQL event-type list identical to spec/events.schema.json', async () => {
      const failing: string[] = [];
      for (const t of eventTypes) {
        const op = await newOp('reconcile', 'running');
        if ((await code(`SELECT ops.advance_operation($1, NULL, 's', $2)`, [op, t])) !== 'ok') failing.push(t);
      }
      expect(failing).toEqual([]);
    });

    it('records the adapter mode once and refuses to change it', async () => {
      const op = await newOp('reconcile', 'running');
      expect(await code(`SELECT ops.advance_operation($1, NULL, 's', 'operation.step.completed', NULL, NULL, 'automation', NULL, 'simulation')`, [op])).toBe('ok');
      expect(await code(`SELECT ops.advance_operation($1, NULL, 's', 'operation.step.completed', NULL, NULL, 'automation', NULL, 'real')`, [op])).toBe('CDR04');
    });
  });

  describe('reconcile, failover and scale-in support (ops/0012)', () => {
    it('lets a worker leave waiting/verifying for reconciling and a re-dispatch replace the execution id only then', async () => {
      const op = await newOp('scale_out', 'running');
      await q(`UPDATE ops.operations SET stackstorm_execution_id = 'exec-1' WHERE id = $1`, [op]);
      expect(await code(`SELECT ops.advance_operation($1, 'waiting', 'w', 'operation.waiting')`, [op])).toBe('ok');
      expect(await code(`SELECT ops.advance_operation($1, 'reconciling', 'r', 'operation.step.completed')`, [op])).toBe('ok');
      expect(await code(`SELECT ops.advance_operation($1, 'running', 'resume', 'operation.step.completed', NULL, NULL, 'automation', 'exec-2')`, [op])).toBe('ok');
      expect((await one(`SELECT stackstorm_execution_id AS e FROM ops.operations WHERE id = $1`, [op])).e).toBe('exec-2');
      expect(await code(`SELECT ops.advance_operation($1, NULL, 's', 'operation.step.completed', NULL, NULL, 'automation', 'exec-3')`, [op])).toBe('CDR04'); // not reconciling
    });

    it('supersedes only queued operations of the named kind, as a succeeded no-op', async () => {
      const queued = await newOp('scale_in', 'queued');
      const running = await newOp('scale_in', 'running');
      const other = await newOp('scale_out', 'queued');
      const by = await newOp('primary_failure', 'running');
      expect((await one(`SELECT ops.supersede_queued('scale_in', $1) AS ids`, [by])).ids).toEqual([queued]);
      expect(await one(`SELECT status, outcome ->> 'noop_reason' AS r FROM ops.operations WHERE id = $1`, [queued])).toEqual({ status: 'succeeded', r: 'superseded' });
      expect((await one(`SELECT status FROM ops.operations WHERE id = $1`, [running])).status).toBe('running');
      expect((await one(`SELECT status FROM ops.operations WHERE id = $1`, [other])).status).toBe('queued');
    });

    it('holds a free slot for an unmatched tagged resource, reconcile only, without freeing or deleting anything', async () => {
      const non = await owner('scale_out');
      expect(await code(`SELECT ops.hold_orphan_slot($1, $2, 'elastic-do-1', 'digitalocean', 'sim-digitalocean-9', true)`, [non.op, non.gen])).toBe('CDR02');
      const rec = await owner('reconcile');
      expect(await code(`SELECT ops.hold_orphan_slot($1, $2, 'elastic-do-1', 'linode', 'sim-x', true)`, [rec.op, rec.gen])).toBe('CDR02'); // provider mismatch
      expect(await code(`SELECT ops.hold_orphan_slot($1, $2, 'elastic-do-1', 'digitalocean', 'sim-digitalocean-9', true)`, [rec.op, rec.gen])).toBe('ok');
      expect(await one(`SELECT state, lease_operation_id FROM ops.capacity_slots WHERE key = 'elastic-do-1'`)).toEqual({ state: 'held_uncertain', lease_operation_id: null });
      expect(await occupied('digitalocean')).toBe(1);
      expect(await code(`SELECT ops.hold_orphan_slot($1, $2, 'elastic-do-1', 'digitalocean', 'sim-digitalocean-9', true)`, [rec.op, rec.gen])).toBe('CDR02'); // no longer free
      expect(await code(`SELECT ops.hold_orphan_slot($1, $2, 'elastic-do-2', 'digitalocean', 'sim-digitalocean-8', true)`, [rec.op, rec.gen + 1])).toBe('CDR01');
    });

    it('finishes an attempt of a dead operation only for reconcile, following the attempt transitions', async () => {
      const dead = await owner('scale_out');
      const r = (await reserve(dead, 'linode'))!;
      await q(`SELECT * FROM ops.start_attempt($1, $2, 1, 'linode', $3, $4)`, [dead.op, dead.gen, r.reserved_key, r.reserved_generation]);
      const rec = await owner('reconcile');
      expect(await code(`SELECT ops.reconcile_attempt($1, $2, $3, 1, 'cleaned')`, [rec.op, rec.gen, dead.op])).toBe('CDR03'); // started -> cleaned is not allowed
      expect(await code(`SELECT ops.reconcile_attempt($1, $2, $3, 1, 'failed', 'interrupted')`, [rec.op, rec.gen, dead.op])).toBe('ok');
      expect((await one(`SELECT status FROM ops.operation_attempts WHERE operation_id = $1`, [dead.op])).status).toBe('failed');
      const notRec = await owner('scale_in');
      expect(await code(`SELECT ops.reconcile_attempt($1, $2, $3, 1, 'cleaned')`, [notRec.op, notRec.gen, dead.op])).toBe('CDR02');
    });

    it('sets routing for a bound ready slot only, with the draining lifecycle following the mode', async () => {
      const o = await owner();
      const r = (await reserve(o, 'linode'))!;
      const g = Number(r.reserved_generation);
      await bindOk(o, r.reserved_key, g, 'sim-linode-1');
      expect(await code(`SELECT ops.set_routing($1, $2, $3, $4, 'active')`, [o.op, o.gen, r.reserved_key, g])).toBe('CDR03'); // not ready yet
      await q(`SELECT ops.set_instance_state($1, $2, $3, $4, 'ready', 'on', 'sha256:a')`, [o.op, o.gen, r.reserved_key, g]);
      expect(await code(`SELECT ops.set_routing($1, $2, $3, $4, 'active')`, [o.op, o.gen, r.reserved_key, g])).toBe('ok');
      expect(await code(`SELECT ops.set_routing($1, $2, $3, $4, 'draining')`, [o.op, o.gen, r.reserved_key, g])).toBe('ok');
      expect(await one(`SELECT routing_mode, lifecycle_state FROM ops.instances WHERE slot_key = $1`, [r.reserved_key])).toEqual({ routing_mode: 'draining', lifecycle_state: 'draining' });
      expect(await code(`SELECT ops.set_routing($1, $2, $3, $4, 'active')`, [o.op, o.gen, r.reserved_key, g])).toBe('ok'); // drain timeout: back in service
      expect((await one(`SELECT lifecycle_state FROM ops.instances WHERE slot_key = $1`, [r.reserved_key])).lifecycle_state).toBe('ready');
      expect(await code(`SELECT ops.set_routing($1, $2, $3, $4, 'active')`, [o.op, o.gen + 1, r.reserved_key, g])).toBe('CDR01');
    });

    it('tracks metrics staleness and resolves an open incident once', async () => {
      await q(`SELECT ops.set_metrics_stale(true)`);
      expect((await one(`SELECT metrics_stale_since IS NOT NULL AS s FROM ops.runtime_flags`)).s).toBe(true);
      await q(`SELECT ops.set_metrics_stale(false)`);
      expect((await one(`SELECT metrics_stale_since IS NULL AS s FROM ops.runtime_flags`)).s).toBe(true);
      await q(`SELECT * FROM ops.open_incident('primary.unhealthy:relief', 'critical', 'automation', 'down')`);
      expect((await one(`SELECT ops.resolve_incident('primary.unhealthy:relief', 'recovered') AS r`)).r).toBe(true);
      expect((await one(`SELECT ops.resolve_incident('primary.unhealthy:relief', 'recovered') AS r`)).r).toBe(false);
    });
  });

  describe('provisioning path (ops/0011)', () => {
    it('stores every policy checkpoint and the deadline with the attempt', async () => {
      const o = await owner();
      const r = (await reserve(o, 'digitalocean'))!;
      const a = await one(`SELECT * FROM ops.start_attempt($1, $2, 1, 'digitalocean', $3, $4)`, [o.op, o.gen, r.reserved_key, r.reserved_generation]);
      expect(a.created).toBe(true);
      const row = await one(
        `SELECT (SELECT array_agg(extract(epoch FROM c - started_at)::int ORDER BY ord) FROM unnest(checkpoints_at) WITH ORDINALITY u (c, ord)) AS cps,
                extract(epoch FROM deadline_at - started_at)::int AS d FROM ops.operation_attempts WHERE operation_id = $1`,
        [o.op],
      );
      expect(row.cps).toEqual(policyDefaults.provisioning.readiness_checkpoints_seconds);
      expect(row.d).toBe(policyDefaults.provisioning.readiness_deadline_seconds);
      const again = await one(`SELECT * FROM ops.start_attempt($1, $2, 1, 'digitalocean', $3, $4)`, [o.op, o.gen, r.reserved_key, r.reserved_generation]);
      expect(again.created).toBe(false);
      expect(again.checkpoints_at).toEqual(a.checkpoints_at);
    });

    it('records deploy, ready and power state only for the lease holder on a bound slot', async () => {
      const o = await owner();
      const r = (await reserve(o, 'linode'))!;
      const args = (lc: string) => [o.op, o.gen, r.reserved_key, r.reserved_generation, lc, 'on', 'sha256:abc'];
      expect(await code(`SELECT ops.set_instance_state($1, $2, $3, $4, $5, $6, $7)`, args('deploying'))).toBe('CDR02'); // still reserved
      await bindOk(o, r.reserved_key, Number(r.reserved_generation), 'sim-linode-1');
      expect(await code(`SELECT ops.set_instance_state($1, $2, $3, $4, $5, $6, $7)`, args('ready'))).toBe('ok');
      expect(await one(`SELECT lifecycle_state, power_state, image_digest FROM ops.instances WHERE slot_key = $1`, [r.reserved_key])).toEqual({
        lifecycle_state: 'ready', power_state: 'on', image_digest: 'sha256:abc',
      });
      expect(await code(`SELECT ops.set_instance_state($1, $2, $3, $4, 'deleted', 'on', NULL)`, [o.op, o.gen, r.reserved_key, r.reserved_generation])).toBe('CDR04');
      expect(await code(`SELECT ops.set_instance_state($1, $2, $3, $4, 'ready', 'on', NULL)`, [o.op, o.gen + 1, r.reserved_key, r.reserved_generation])).toBe('CDR01');
    });

    it('opens an automation operation once per fingerprint, capturing the active policy version', async () => {
      const a = await one(`SELECT * FROM ops.open_operation('scale_out', 'alertmanager', 'cpu.high:relief', 'AppCpuHigh')`);
      expect(a).toMatchObject({ created: true, policy_version: 1 });
      expect(await one(`SELECT kind, status, policy_version FROM ops.operations WHERE id = $1`, [a.operation_id])).toEqual({ kind: 'scale_out', status: 'queued', policy_version: 1 });
      const b = await one(`SELECT * FROM ops.open_operation('scale_out', 'alertmanager', 'cpu.high:relief', 'AppCpuHigh')`);
      expect(b).toMatchObject({ operation_id: a.operation_id, created: false });
      // a terminal operation does not absorb the next trigger
      await q(`UPDATE ops.operations SET status = 'failed' WHERE id = $1`, [a.operation_id]);
      const c = await one(`SELECT * FROM ops.open_operation('scale_out', 'alertmanager', 'cpu.high:relief', 'AppCpuHigh')`);
      expect(c.created).toBe(true);
      expect(c.operation_id).not.toBe(a.operation_id);
      expect((await one(`SELECT operation_id FROM ops.processed_events WHERE fingerprint = 'cpu.high:relief'`)).operation_id).toBe(c.operation_id);
    });

    it('creates exactly one operation for concurrent identical triggers', async () => {
      const clients = await Promise.all([1, 2, 3, 4].map(async () => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; }));
      try {
        const rows = await Promise.all(clients.map((c) => c.query(`SELECT * FROM ops.open_operation('primary_failure', 'automation', 'primary.unhealthy:relief')`)));
        expect(new Set(rows.map((r) => r.rows[0].operation_id)).size).toBe(1);
        expect(rows.filter((r) => r.rows[0].created)).toHaveLength(1);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });

    it('refuses operator-only kinds, unknown sources and a missing active policy', async () => {
      expect(await code(`SELECT * FROM ops.open_operation('create_backup', 'automation', 'x')`)).toBe('CDR04');
      expect(await code(`SELECT * FROM ops.open_operation('scale_out', 'dashboard', 'x')`)).toBe('CDR04');
      expect(await code(`SELECT * FROM ops.open_operation('scale_out', 'automation', '')`)).toBe('CDR04');
      await q(`UPDATE ops.policy_versions SET status = 'superseded'`);
      expect(await code(`SELECT * FROM ops.open_operation('scale_out', 'automation', 'x')`)).toBe('CDR04');
    });

    it('upserts one open incident per fingerprint and records an event each time', async () => {
      const op = await newOp();
      const a = await one(`SELECT * FROM ops.open_incident('provision.exhausted:o1', 'critical', 'automation', 'first', ARRAY['digitalocean'], $1)`, [op]);
      const b = await one(`SELECT * FROM ops.open_incident('provision.exhausted:o1', 'critical', 'automation', 'second', ARRAY['digitalocean', 'linode'], $1)`, [op]);
      expect(a.created).toBe(true);
      expect(b).toMatchObject({ incident_id: a.incident_id, created: false });
      expect(await one(`SELECT description, affected_resources FROM ops.incidents WHERE id = $1`, [a.incident_id])).toEqual({ description: 'second', affected_resources: ['digitalocean', 'linode'] });
      expect((await q(`SELECT event_kind FROM ops.incident_events WHERE incident_id = $1 ORDER BY occurred_at, event_kind DESC`, [a.incident_id])).rows.map((r) => r.event_kind).sort()).toEqual(['opened', 'repeated']);
      await q(`UPDATE ops.incidents SET state = 'resolved' WHERE id = $1`, [a.incident_id]);
      expect((await one(`SELECT * FROM ops.open_incident('provision.exhausted:o1', 'critical', 'automation', 'again', '{}', $1)`, [op])).created).toBe(true);
      expect(await code(`SELECT * FROM ops.open_incident('x', 'fatal', 'automation', 'bad')`)).toBe('CDR04');
    });

    it('denies the management API role every new function and grants them to the automation role', async () => {
      const api = 'cap_test_api_11';
      const st2 = 'cap_test_st2_11';
      for (const [name, groups] of [[api, ['dr_ops']], [st2, ['dr_ops', 'dr_automation']]] as const) {
        await q(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${name} NOLOGIN; END IF; END $$`);
        for (const g of groups) await q(`GRANT ${g} TO ${name}`);
      }
      const as = async (role: string, sql: string) => {
        await q(`SET ROLE ${role}`);
        try {
          return await code(sql);
        } finally {
          await q('RESET ROLE');
        }
      };
      const calls = [
        `SELECT * FROM ops.open_operation('scale_out', 'automation', 'priv')`,
        `SELECT * FROM ops.open_incident('priv', 'info', 'automation', 'd')`,
        `SELECT ops.set_instance_state(gen_random_uuid(), 1, 'warm', 1, 'ready')`,
        `SELECT * FROM ops.start_attempt(gen_random_uuid(), 1, 1, 'linode', 'warm', 1)`,
      ];
      for (const sql of calls) {
        expect(await as(api, sql), `dr_ops: ${sql}`).toBe('42501');
        expect(await as(st2, sql), `dr_automation: ${sql}`).not.toBe('42501');
      }
    });
  });

  describe('privileges', () => {
    it('lets the management API role read capacity state but not write it or call the control functions', async () => {
      const api = 'cap_test_api';
      const st2 = 'cap_test_st2';
      for (const [name, groups] of [[api, ['dr_ops']], [st2, ['dr_ops', 'dr_automation']]] as const) {
        await q(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${name} NOLOGIN; END IF; END $$`);
        for (const g of groups) await q(`GRANT ${g} TO ${name}`);
      }
      const as = async (role: string, sql: string) => {
        await q(`SET ROLE ${role}`);
        try {
          return await code(sql);
        } finally {
          await q('RESET ROLE');
        }
      };
      expect(await as(api, `SELECT count(*) FROM ops.capacity_slots`)).toBe('ok');
      expect(await as(api, `UPDATE ops.capacity_slots SET state = 'bound' WHERE key = 'warm'`)).toBe('42501');
      expect(await as(api, `DELETE FROM ops.instances`)).toBe('42501');
      expect(await as(api, `UPDATE ops.control_leases SET fencing_generation = 99`)).toBe('42501');
      expect(await as(api, `SELECT ops.scale_in_candidate()`)).toBe('42501');
      expect(await as(st2, `UPDATE ops.capacity_slots SET state = 'bound' WHERE key = 'warm'`)).toBe('42501');
      expect(await as(st2, `SELECT ops.scale_in_candidate()`)).toBe('ok');
      expect(await as(st2, `SELECT ops._free_slot('warm', NULL)`)).toBe('42501'); // internal helpers are not callable
      // operation_attempts is written only through the ops.* functions (ops/0010)
      expect(await as(api, `SELECT count(*) FROM ops.operation_attempts`)).toBe('ok');
      expect(await as(api, `INSERT INTO ops.operation_attempts (operation_id, attempt) VALUES (gen_random_uuid(), 1)`)).toBe('42501');
      expect(await as(api, `UPDATE ops.operation_attempts SET status = 'failed'`)).toBe('42501');
      expect(await as(api, `DELETE FROM ops.operation_attempts`)).toBe('42501');
      expect(await as(st2, `DELETE FROM ops.operation_attempts WHERE false`)).toBe('ok');
    });
  });
});
