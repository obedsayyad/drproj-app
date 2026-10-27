-- Phase 4.3 reconcile, primary_failure, scale_in and alert-driven intents (docs/04, docs/07). Same rules as 0009/0011:
-- SECURITY DEFINER, EXECUTE for dr_automation only, errors CDR01..CDR04.

ALTER TABLE ops.runtime_flags ADD COLUMN metrics_stale_since timestamptz;

-- ---------------------------------------------------------------- operation projection
-- waiting|verifying -> reconciling (a fenced or abandoned worker leaves the operation for reconcile), and an execution id
-- may be replaced while the operation is reconciling (reconcile re-dispatches the same operation_id: adoption).
CREATE OR REPLACE FUNCTION ops._operation_transition_ok(cur text, new text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN cur = new THEN cur NOT IN ('succeeded', 'failed', 'cancelled')
    WHEN cur = 'queued' THEN new = 'running'
    WHEN cur = 'running' THEN new IN ('waiting', 'verifying', 'paused', 'reconciling', 'cancelling', 'failed')
    WHEN cur IN ('waiting', 'verifying', 'paused', 'reconciling') THEN new = 'running' OR (new = 'failed' AND cur <> 'paused')
                                                                       OR (cur = 'verifying' AND new = 'succeeded')
                                                                       OR (cur IN ('waiting', 'verifying') AND new = 'reconciling')
    WHEN cur = 'cancelling' THEN new = 'cancelled'
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION ops.advance_operation(p_op uuid, p_status text, p_step text, p_event_type text, p_message text DEFAULT NULL, p_outcome jsonb DEFAULT NULL,
                                                 p_source text DEFAULT 'automation', p_execution_id text DEFAULT NULL, p_adapter_mode text DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  o   ops.operations%ROWTYPE;
  new text;
  seq bigint;
  v_msg text := p_message;
BEGIN
  IF p_event_type <> ALL (ARRAY['app.cpu.high', 'app.cpu.low', 'app.primary.unhealthy', 'app.primary.recovered', 'infrastructure.provision.failed', 'backup.failed',
      'metrics.stale', 'policy.apply.requested', 'reconcile.requested', 'operation.started', 'operation.step.completed', 'operation.waiting', 'operation.paused',
      'operation.succeeded', 'operation.failed', 'operation.cancelled', 'restore.started', 'restore.verified', 'restore.succeeded', 'restore.failed', 'restore.rolled_back',
      'app.memory.saturated', 'certificate.renewal_failed', 'control_state.unavailable', 'control_state.recovered', 'infrastructure.drain.timeout',
      'infrastructure.provision.exhausted', 'standby.unhealthy', 'standby.repaired'])
     OR p_source NOT IN ('dashboard', 'automation', 'reconciliation', 'alertmanager', 'timer')
     OR p_adapter_mode NOT IN ('real', 'simulation') THEN
    RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04';
  END IF;
  SELECT * INTO o FROM ops.operations x WHERE x.id = p_op FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_operation' USING ERRCODE = 'CDR04'; END IF;
  new := coalesce(p_status, o.status);
  IF NOT ops._operation_transition_ok(o.status, new)
     AND NOT (new = 'succeeded' AND o.status IN ('queued', 'running') AND coalesce(p_outcome ->> 'noop_reason', '') <> '') THEN
    RAISE EXCEPTION 'operation_transition_%_%', o.status, new USING ERRCODE = 'CDR03';
  END IF;
  IF o.adapter_mode IS NOT NULL AND p_adapter_mode IS NOT NULL AND o.adapter_mode <> p_adapter_mode THEN RAISE EXCEPTION 'adapter_mode_changed' USING ERRCODE = 'CDR04'; END IF;
  IF o.stackstorm_execution_id IS NOT NULL AND p_execution_id IS NOT NULL AND o.stackstorm_execution_id <> p_execution_id THEN
    IF o.status <> 'reconciling' THEN RAISE EXCEPTION 'execution_id_changed' USING ERRCODE = 'CDR04'; END IF;
    v_msg := left(coalesce(v_msg || ' ', '') || '(adopted from execution ' || o.stackstorm_execution_id || ')', 2000);
  END IF;
  UPDATE ops.operations x
     SET status = new, current_step = coalesce(p_step, x.current_step), updated_at = now(),
         adapter_mode = coalesce(x.adapter_mode, p_adapter_mode),
         stackstorm_execution_id = CASE WHEN x.status = 'reconciling' AND p_execution_id IS NOT NULL THEN p_execution_id ELSE coalesce(x.stackstorm_execution_id, p_execution_id) END,
         outcome = coalesce(p_outcome, x.outcome),
         finished_at = CASE WHEN new IN ('succeeded', 'failed', 'cancelled') THEN now() ELSE x.finished_at END
   WHERE x.id = p_op;
  INSERT INTO ops.operation_events (operation_id, event_type, status, step, message, source)
  VALUES (p_op, p_event_type, new, left(p_step, 200), left(v_msg, 2000), p_source) RETURNING sequence INTO seq;
  RETURN seq;
END $$;

-- ---------------------------------------------------------------- metrics freshness flag
-- The Alertmanager `metrics.stale` notification sets it; its resolution clears it. CPU-driven intents read it (fail closed).
CREATE FUNCTION ops.set_metrics_stale(p_stale boolean) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
BEGIN
  UPDATE ops.runtime_flags f
     SET metrics_stale_since = CASE WHEN p_stale THEN coalesce(f.metrics_stale_since, now()) ELSE NULL END
   WHERE f.singleton;
  RETURN p_stale;
END $$;

-- ---------------------------------------------------------------- routing (database projection; HAProxy itself is P6)
-- Writes routing_mode/weight of the instance bound to a slot. 'active' needs a ready instance; 'draining' marks it draining;
-- returning to active/backup/none clears a draining lifecycle.
CREATE FUNCTION ops.set_routing(p_op uuid, p_lease_gen bigint, p_key text, p_slot_gen bigint, p_mode text, p_weight integer DEFAULT NULL, p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  s ops.capacity_slots%ROWTYPE;
  i ops.instances%ROWTYPE;
BEGIN
  IF p_mode NOT IN ('none', 'backup', 'active', 'draining') OR p_weight NOT BETWEEN 0 AND 256 THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  s := ops._lock_slot(p_op, p_lease_gen, p_key, p_slot_gen, ARRAY['bound', 'releasing'], p_app);
  SELECT * INTO i FROM ops.instances x WHERE x.id = s.bound_instance_id FOR UPDATE;
  IF p_mode IN ('active', 'backup') AND i.lifecycle_state NOT IN ('ready', 'draining') THEN RAISE EXCEPTION 'instance_not_ready' USING ERRCODE = 'CDR03'; END IF;
  IF p_mode = 'draining' AND i.lifecycle_state NOT IN ('ready', 'draining') THEN RAISE EXCEPTION 'instance_not_ready' USING ERRCODE = 'CDR03'; END IF;
  UPDATE ops.instances x
     SET routing_mode = p_mode,
         routing_weight = coalesce(p_weight, CASE WHEN p_mode = 'active' THEN 100 ELSE 0 END),
         lifecycle_state = CASE WHEN p_mode = 'draining' THEN 'draining' WHEN x.lifecycle_state = 'draining' AND p_mode IN ('active', 'backup') THEN 'ready' ELSE x.lifecycle_state END
   WHERE x.id = i.id;
  PERFORM ops._audit('routing.set', 'slot:' || p_key, jsonb_build_object('mode', i.routing_mode), jsonb_build_object('mode', p_mode), p_op);
END $$;

-- ---------------------------------------------------------------- reconcile-only slot and attempt writers
CREATE FUNCTION ops._require_reconcile(p_op uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE k text;
BEGIN
  SELECT o.kind INTO k FROM ops.operations o WHERE o.id = p_op;
  IF k IS DISTINCT FROM 'reconcile' THEN RAISE EXCEPTION 'reconcile_only' USING ERRCODE = 'CDR02'; END IF;
END $$;

-- A project-tagged resource claims a FREE slot that no operation holds: keep the slot occupied (counted) as held_uncertain.
-- The resource is never touched; an incident and the operator runbook decide (docs/15 section 1).
CREATE FUNCTION ops.hold_orphan_slot(p_op uuid, p_lease_gen bigint, p_key text, p_provider text, p_resource_id text, p_simulated boolean DEFAULT false, p_app text DEFAULT 'relief') RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  s   ops.capacity_slots%ROWTYPE;
  v_iid uuid;
  v_gen bigint;
BEGIN
  PERFORM ops._require_reconcile(p_op);
  PERFORM ops.assert_lease(p_op, p_lease_gen, p_app);
  IF coalesce(p_resource_id, '') = '' OR p_provider NOT IN ('digitalocean', 'linode') THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  PERFORM 1 FROM ops.capacity_slots c ORDER BY c.key FOR UPDATE;
  SELECT * INTO s FROM ops.capacity_slots c WHERE c.key = p_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_slot' USING ERRCODE = 'CDR04'; END IF;
  IF s.state <> 'free' OR s.provider <> p_provider THEN RAISE EXCEPTION 'slot_not_free' USING ERRCODE = 'CDR02'; END IF;
  INSERT INTO ops.instances (slot_key, provider, provider_resource_id, role, lifecycle_state, slot_state, simulated, power_state, last_seen_at)
  VALUES (p_key, p_provider, p_resource_id, s.role, 'unknown', 'held_uncertain', p_simulated, 'unknown', now()) RETURNING id INTO v_iid;
  UPDATE ops.capacity_slots c SET state = 'held_uncertain', generation = c.generation + 1, bound_instance_id = v_iid, lease_operation_id = NULL, updated_at = now()
   WHERE c.key = p_key RETURNING c.generation INTO v_gen;
  PERFORM ops._audit('slot.held_uncertain', 'slot:' || p_key, jsonb_build_object('state', 'free'), jsonb_build_object('reason', 'unmatched_tagged_resource', 'resource_id', p_resource_id), p_op);
  RETURN v_gen;
END $$;

-- Finish an attempt of an operation that no longer runs (same transitions as finish_attempt, but the lease holder is the reconcile).
CREATE FUNCTION ops.reconcile_attempt(p_op uuid, p_lease_gen bigint, p_target_op uuid, p_attempt integer, p_status text, p_error_code text DEFAULT NULL, p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE cur text;
BEGIN
  PERFORM ops._require_reconcile(p_op);
  PERFORM ops.assert_lease(p_op, p_lease_gen, p_app);
  SELECT a.status INTO cur FROM ops.operation_attempts a WHERE a.operation_id = p_target_op AND a.attempt = p_attempt FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_attempt' USING ERRCODE = 'CDR04'; END IF;
  IF NOT (   (cur = 'started'   AND p_status IN ('ready', 'failed', 'uncertain'))
          OR (cur = 'failed'    AND p_status IN ('cleaned', 'uncertain'))
          OR (cur = 'uncertain' AND p_status IN ('ready', 'failed', 'cleaned'))) THEN
    RAISE EXCEPTION 'attempt_transition_%_%', cur, p_status USING ERRCODE = 'CDR03';
  END IF;
  UPDATE ops.operation_attempts a SET status = p_status, error_code = left(p_error_code, 100) WHERE a.operation_id = p_target_op AND a.attempt = p_attempt;
END $$;

-- ---------------------------------------------------------------- intents
-- Queued (never started) operations of one kind become succeeded no-ops; a failure-triggered intent preempts a queued scale-in (docs/07).
CREATE FUNCTION ops.supersede_queued(p_kind text, p_by uuid) RETURNS text[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  r record;
  ids text[] := '{}';
BEGIN
  IF p_kind NOT IN ('scale_out', 'scale_in', 'primary_failure', 'standby_repair', 'activate_standby') THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  FOR r IN SELECT o.id FROM ops.operations o WHERE o.kind = p_kind AND o.status = 'queued' AND o.id <> p_by ORDER BY o.created_at FOR UPDATE LOOP
    PERFORM ops.advance_operation(r.id, 'succeeded', 'superseded', 'operation.succeeded', 'superseded by ' || p_by::text,
                                  jsonb_build_object('noop_reason', 'superseded', 'superseded_by', p_by));
    ids := ids || r.id::text;
  END LOOP;
  RETURN ids;
END $$;

-- Resolves the open incident of a fingerprint; false when none is open.
CREATE FUNCTION ops.resolve_incident(p_fingerprint text, p_message text, p_op uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE v_id uuid;
BEGIN
  UPDATE ops.incidents i SET state = 'resolved', resolved_at = now() WHERE i.fingerprint = p_fingerprint AND i.state = 'open' RETURNING i.id INTO v_id;
  IF v_id IS NULL THEN RETURN false; END IF;
  INSERT INTO ops.incident_events (incident_id, event_kind, message, source, operation_id) VALUES (v_id, 'resolved', left(p_message, 2000), 'automation', p_op);
  RETURN true;
END $$;

-- ---------------------------------------------------------------- grants
REVOKE ALL ON FUNCTION
  ops.set_metrics_stale(boolean),
  ops.set_routing(uuid, bigint, text, bigint, text, integer, text),
  ops._require_reconcile(uuid),
  ops.hold_orphan_slot(uuid, bigint, text, text, text, boolean, text),
  ops.reconcile_attempt(uuid, bigint, uuid, integer, text, text, text),
  ops.supersede_queued(text, uuid),
  ops.resolve_incident(text, text, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  ops.set_metrics_stale(boolean),
  ops.set_routing(uuid, bigint, text, bigint, text, integer, text),
  ops.hold_orphan_slot(uuid, bigint, text, text, text, boolean, text),
  ops.reconcile_attempt(uuid, bigint, uuid, integer, text, text, text),
  ops.supersede_queued(text, uuid),
  ops.resolve_incident(text, text, uuid)
  TO dr_automation;
