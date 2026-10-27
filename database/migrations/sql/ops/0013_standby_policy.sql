-- P4.4: warm standby surplus rule for scale-in, and the apply_policy workflow's access to the pending policy version.

-- Scale-in candidate: while the original warm slot is bound and ready AND an interim-warm slot is bound, the interim slot is the
-- surplus warm-role slot and is the candidate (begin_slot_release allows scale_in to release a warm-role slot only in that case).
-- Otherwise the newest bound elastic slot. A lone warm-role slot is never a candidate.
CREATE OR REPLACE FUNCTION ops.scale_in_candidate() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
  SELECT coalesce(
    (SELECT s.key FROM ops.capacity_slots s
      WHERE s.key LIKE 'interim-warm-%' AND s.state = 'bound'
        AND EXISTS (SELECT 1 FROM ops.capacity_slots w JOIN ops.instances wi ON wi.id = w.bound_instance_id
                     WHERE w.key = 'warm' AND w.state = 'bound' AND wi.lifecycle_state = 'ready')
      ORDER BY s.key LIMIT 1),
    (SELECT s.key FROM ops.capacity_slots s JOIN ops.instances i ON i.id = s.bound_instance_id
      WHERE s.role = 'elastic' AND s.state = 'bound' ORDER BY i.created_at DESC, s.key DESC LIMIT 1))
$$;

-- set_instance_state: a standby_repair or reconcile operation may also record the state of a bound warm-role slot that an earlier
-- operation provisioned (repairing an existing standby is the whole point of standby_repair); every other slot still needs its owner.
CREATE OR REPLACE FUNCTION ops.set_instance_state(p_op uuid, p_lease_gen bigint, p_key text, p_slot_gen bigint, p_lifecycle text, p_power_state text DEFAULT NULL,
                                                  p_image_digest text DEFAULT NULL, p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  s ops.capacity_slots%ROWTYPE;
  k text;
BEGIN
  IF p_lifecycle NOT IN ('provisioning', 'deploying', 'ready', 'failed') OR p_power_state NOT IN ('on', 'off', 'unknown') THEN
    RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04';
  END IF;
  s := ops._lock_slot(p_op, p_lease_gen, p_key, p_slot_gen, ARRAY['bound'], p_app);
  IF s.lease_operation_id IS DISTINCT FROM p_op THEN
    SELECT o.kind INTO k FROM ops.operations o WHERE o.id = p_op;
    IF s.role IS DISTINCT FROM 'warm' OR k IS NULL OR k NOT IN ('standby_repair', 'reconcile') THEN
      RAISE EXCEPTION 'slot_owned_by_other_operation' USING ERRCODE = 'CDR02';
    END IF;
  END IF;
  UPDATE ops.instances i
     SET lifecycle_state = p_lifecycle, power_state = coalesce(p_power_state, i.power_state),
         image_digest = coalesce(p_image_digest, i.image_digest), last_seen_at = now()
   WHERE i.id = s.bound_instance_id;
END $$;

-- Moves the pending version through the activation phases (docs/03 steps 3-6). Only the apply_policy operation of that version may.
CREATE FUNCTION ops.set_policy_phase(p_op uuid, p_version integer, p_phase text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE k text; prm integer;
BEGIN
  IF p_phase NOT IN ('validating', 'compiling', 'applying', 'verifying') THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  SELECT o.kind, (o.parameters ->> 'policy_version')::integer INTO k, prm FROM ops.operations o WHERE o.id = p_op;
  IF k IS DISTINCT FROM 'apply_policy' OR prm IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'not_this_policy_operation' USING ERRCODE = 'CDR02'; END IF;
  UPDATE ops.policy_versions p SET activation_phase = p_phase WHERE p.version = p_version AND p.status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'policy_not_pending' USING ERRCODE = 'CDR03'; END IF;
END $$;

-- Activation or failure of the pending version, called by the apply_policy workflow (success keeps the old version active on failure).
-- `p_pending_transition` records cap reductions below the occupied count (docs/03: a pending transition, never a forced delete).
CREATE FUNCTION ops.finish_policy_apply(p_op uuid, p_version integer, p_success boolean, p_result jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE k text; prm integer;
BEGIN
  SELECT o.kind, (o.parameters ->> 'policy_version')::integer INTO k, prm FROM ops.operations o WHERE o.id = p_op;
  IF k IS DISTINCT FROM 'apply_policy' OR prm IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'not_this_policy_operation' USING ERRCODE = 'CDR02'; END IF;
  RETURN ops.finish_policy_activation(p_version, p_success, p_result);
END $$;

-- Reconcile closes the pending version of an apply_policy operation that no longer runs: failed, the old version stays active.
CREATE FUNCTION ops.fail_pending_policy(p_op uuid, p_lease_gen bigint, p_target_op uuid, p_reason text, p_app text DEFAULT 'relief') RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE v integer;
BEGIN
  PERFORM ops._require_reconcile(p_op);
  PERFORM ops.assert_lease(p_op, p_lease_gen, p_app);
  SELECT (o.parameters ->> 'policy_version')::integer INTO v FROM ops.operations o WHERE o.id = p_target_op AND o.kind = 'apply_policy';
  IF v IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM ops.policy_versions p WHERE p.version = v AND p.status = 'pending';
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM ops.finish_policy_activation(v, false, jsonb_build_object('error', left(coalesce(p_reason, 'interrupted'), 100), 'by', 'reconcile'));
  RETURN true;
END $$;

-- ---------------------------------------------------------------- grants
REVOKE ALL ON FUNCTION
  ops.set_policy_phase(uuid, integer, text),
  ops.finish_policy_apply(uuid, integer, boolean, jsonb),
  ops.fail_pending_policy(uuid, bigint, uuid, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  ops.set_policy_phase(uuid, integer, text),
  ops.finish_policy_apply(uuid, integer, boolean, jsonb),
  ops.fail_pending_policy(uuid, bigint, uuid, text, text)
  TO dr_automation;
GRANT SELECT ON ops.policy_versions TO dr_automation;
