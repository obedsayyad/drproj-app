-- Phase 4.2 provisioning path (docs/04, docs/05, docs/07). Adds the functions automation needs to open its own
-- operations and incidents, store every readiness checkpoint with the attempt, and record deploy/ready/power state
-- of a bound instance. Same rules as 0009: SECURITY DEFINER, EXECUTE for dr_automation only, errors CDR01..CDR04.

-- ---------------------------------------------------------------- shape
ALTER TABLE ops.operation_attempts ADD COLUMN checkpoints_at timestamptz[];
ALTER TABLE ops.instances ADD COLUMN power_state text CHECK (power_state IN ('on', 'off', 'unknown'));

-- ---------------------------------------------------------------- attempts: all checkpoints + deadline from the captured policy
-- The return type changes (checkpoints_at added), so the 0009 function is replaced.
DROP FUNCTION ops.start_attempt(uuid, bigint, integer, text, text, bigint, text);
CREATE FUNCTION ops.start_attempt(p_op uuid, p_lease_gen bigint, p_attempt integer, p_provider text, p_slot_key text, p_slot_gen bigint, p_app text DEFAULT 'relief')
RETURNS TABLE (attempt_id uuid, created boolean, deadline_at timestamptz, checkpoint_at timestamptz, checkpoints_at timestamptz[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  s   ops.capacity_slots%ROWTYPE;
  pol jsonb;
  v_id uuid;
  v_now timestamptz := now();
  v_cps timestamptz[];
BEGIN
  IF p_provider NOT IN ('digitalocean', 'linode') THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  s := ops._lock_slot(p_op, p_lease_gen, p_slot_key, p_slot_gen, ARRAY['reserved', 'bound'], p_app);
  IF s.lease_operation_id IS DISTINCT FROM p_op OR s.provider <> p_provider THEN RAISE EXCEPTION 'slot_owned_by_other_operation' USING ERRCODE = 'CDR02'; END IF;
  SELECT p.configuration -> 'provisioning' INTO pol FROM ops.policy_versions p JOIN ops.operations o ON o.policy_version = p.version WHERE o.id = p_op;
  IF pol IS NULL THEN RAISE EXCEPTION 'policy_not_found' USING ERRCODE = 'CDR04'; END IF;
  SELECT array_agg(v_now + make_interval(secs => c::int) ORDER BY ord) INTO v_cps
    FROM jsonb_array_elements_text(pol -> 'readiness_checkpoints_seconds') WITH ORDINALITY AS t (c, ord);
  INSERT INTO ops.operation_attempts AS a (operation_id, attempt, provider, slot_key, slot_generation, checkpoint_at, checkpoints_at, deadline_at)
  VALUES (p_op, p_attempt, p_provider, p_slot_key, p_slot_gen, v_cps[1], v_cps,
          v_now + make_interval(secs => (pol ->> 'readiness_deadline_seconds')::int))
  ON CONFLICT (operation_id, attempt) DO NOTHING
  RETURNING a.attempt_id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT a.attempt_id, true, a.deadline_at, a.checkpoint_at, a.checkpoints_at FROM ops.operation_attempts a WHERE a.attempt_id = v_id;
  ELSE
    RETURN QUERY SELECT a.attempt_id, false, a.deadline_at, a.checkpoint_at, a.checkpoints_at FROM ops.operation_attempts a WHERE a.operation_id = p_op AND a.attempt = p_attempt;
  END IF;
END $$;

-- ---------------------------------------------------------------- instance state (fenced)
-- Records deploy/ready/failed and power state of the instance bound to a slot, so no worker writes instances directly.
CREATE FUNCTION ops.set_instance_state(p_op uuid, p_lease_gen bigint, p_key text, p_slot_gen bigint, p_lifecycle text, p_power_state text DEFAULT NULL,
                                       p_image_digest text DEFAULT NULL, p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE s ops.capacity_slots%ROWTYPE;
BEGIN
  IF p_lifecycle NOT IN ('provisioning', 'deploying', 'ready', 'failed') OR p_power_state NOT IN ('on', 'off', 'unknown') THEN
    RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04';
  END IF;
  s := ops._lock_slot(p_op, p_lease_gen, p_key, p_slot_gen, ARRAY['bound'], p_app);
  IF s.lease_operation_id IS DISTINCT FROM p_op THEN RAISE EXCEPTION 'slot_owned_by_other_operation' USING ERRCODE = 'CDR02'; END IF;
  UPDATE ops.instances i
     SET lifecycle_state = p_lifecycle, power_state = coalesce(p_power_state, i.power_state),
         image_digest = coalesce(p_image_digest, i.image_digest), last_seen_at = now()
   WHERE i.id = s.bound_instance_id;
END $$;

-- ---------------------------------------------------------------- automation-originated operations
-- Opens (or returns) the operation for an automation intent. The fingerprint coalesces repeated triggers: while the
-- linked operation is not terminal it is returned (created = false); a terminal one is replaced by a new operation.
-- The active policy version is captured here (docs/05); no active policy => CDR04 (fail closed).
CREATE FUNCTION ops.open_operation(p_kind text, p_source text, p_fingerprint text, p_event_name text DEFAULT NULL)
RETURNS TABLE (operation_id uuid, created boolean, policy_version integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  v_pv  integer;
  v_cur uuid;
  v_st  text;
  v_op  uuid;
BEGIN
  IF p_kind NOT IN ('scale_out', 'scale_in', 'primary_failure', 'standby_repair', 'reconcile', 'activate_standby')
     OR p_source NOT IN ('automation', 'alertmanager', 'timer', 'reconciliation')
     OR coalesce(p_fingerprint, '') = '' OR char_length(p_fingerprint) > 256 THEN
    RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04';
  END IF;
  SELECT p.version INTO v_pv FROM ops.policy_versions p WHERE p.status = 'active';
  IF v_pv IS NULL THEN RAISE EXCEPTION 'no_active_policy' USING ERRCODE = 'CDR04'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('open_operation:' || p_fingerprint, 0));
  SELECT e.operation_id, o.status INTO v_cur, v_st
    FROM ops.processed_events e LEFT JOIN ops.operations o ON o.id = e.operation_id
   WHERE e.fingerprint = p_fingerprint AND e.policy_version = v_pv;
  IF v_cur IS NOT NULL AND v_st NOT IN ('succeeded', 'failed', 'cancelled') THEN
    UPDATE ops.processed_events e SET last_seen_at = now() WHERE e.fingerprint = p_fingerprint AND e.policy_version = v_pv;
    RETURN QUERY SELECT v_cur, false, v_pv;
    RETURN;
  END IF;
  INSERT INTO ops.operations (kind, policy_version) VALUES (p_kind, v_pv) RETURNING id INTO v_op;
  INSERT INTO ops.processed_events AS e (fingerprint, policy_version, operation_id, source, event_name)
  VALUES (p_fingerprint, v_pv, v_op, p_source, left(p_event_name, 100))
  ON CONFLICT ON CONSTRAINT processed_events_pkey DO UPDATE SET operation_id = v_op, last_seen_at = now(), source = EXCLUDED.source, event_name = EXCLUDED.event_name;
  PERFORM ops._audit('operation.opened', 'operation:' || v_op::text, NULL, jsonb_build_object('kind', p_kind, 'source', p_source, 'policy_version', v_pv), v_op);
  RETURN QUERY SELECT v_op, true, v_pv;
END $$;

-- ---------------------------------------------------------------- incidents
-- One open incident per fingerprint (incidents_one_open_per_fingerprint): a repeat refreshes it and adds an event.
CREATE FUNCTION ops.open_incident(p_fingerprint text, p_severity text, p_source text, p_description text, p_resources text[] DEFAULT '{}', p_op uuid DEFAULT NULL)
RETURNS TABLE (incident_id uuid, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  v_id  uuid;
  v_new boolean;
BEGIN
  IF coalesce(p_fingerprint, '') = '' OR char_length(p_fingerprint) > 256 OR p_severity NOT IN ('info', 'warning', 'critical') THEN
    RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04';
  END IF;
  INSERT INTO ops.incidents AS i (fingerprint, severity, source, description, affected_resources)
  VALUES (p_fingerprint, p_severity, left(p_source, 100), left(p_description, 2000), coalesce(p_resources, '{}'))
  ON CONFLICT (fingerprint) WHERE state = 'open'
  DO UPDATE SET description = EXCLUDED.description, affected_resources = EXCLUDED.affected_resources
  RETURNING i.id, (i.xmax = 0) INTO v_id, v_new;
  INSERT INTO ops.incident_events (incident_id, event_kind, message, source, operation_id)
  VALUES (v_id, CASE WHEN v_new THEN 'opened' ELSE 'repeated' END, left(p_description, 2000), left(p_source, 100), p_op);
  RETURN QUERY SELECT v_id, v_new;
END $$;

-- ---------------------------------------------------------------- grants
REVOKE ALL ON FUNCTION
  ops.start_attempt(uuid, bigint, integer, text, text, bigint, text),
  ops.set_instance_state(uuid, bigint, text, bigint, text, text, text, text),
  ops.open_operation(text, text, text, text),
  ops.open_incident(text, text, text, text, text[], uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  ops.start_attempt(uuid, bigint, integer, text, text, bigint, text),
  ops.set_instance_state(uuid, bigint, text, bigint, text, text, text, text),
  ops.open_operation(text, text, text, text),
  ops.open_incident(text, text, text, text, text[], uuid)
  TO dr_automation;
