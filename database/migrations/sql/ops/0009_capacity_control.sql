-- Phase 4 capacity control (docs/04, docs/05, docs/07). Capacity state changes only through the SECURITY
-- DEFINER functions below, executable by the StackStorm login (member of dr_ops AND dr_automation); the
-- management API (dr_ops only) keeps read access. Errors use SQLSTATEs the actions map to short codes:
--   CDR01 lease_lost            CDR02 slot_conflict (state, generation, ownership, warm protection)
--   CDR03 invalid_transition    CDR04 bad_argument
-- "No capacity" is not an error: reserve_slot returns no rows.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dr_automation') THEN
    CREATE ROLE dr_automation NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA ops TO dr_automation;

-- ---------------------------------------------------------------- shape
ALTER TABLE ops.capacity_slots
  ADD CONSTRAINT capacity_slots_free_is_empty CHECK (state <> 'free' OR (bound_instance_id IS NULL AND lease_operation_id IS NULL)),
  ADD CONSTRAINT capacity_slots_occupied_has_instance CHECK (state = 'free' OR bound_instance_id IS NOT NULL);

-- Immutable ceiling (docs/03): never more than 5 occupied slots per provider, whoever writes.
CREATE FUNCTION ops.capacity_slots_ceiling() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, ops
AS $$
BEGIN
  IF NEW.state <> 'free'
     AND (SELECT count(*) FROM ops.capacity_slots s WHERE s.provider = NEW.provider AND s.state <> 'free' AND s.key <> NEW.key) >= 5 THEN
    RAISE EXCEPTION 'provider_ceiling' USING ERRCODE = 'CDR02';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capacity_slots_ceiling BEFORE INSERT OR UPDATE ON ops.capacity_slots
  FOR EACH ROW EXECUTE FUNCTION ops.capacity_slots_ceiling();

-- Marks inventory and operations produced by a local simulation adapter (docs/10: never presented as real).
ALTER TABLE ops.instances ADD COLUMN simulated boolean NOT NULL DEFAULT false;
ALTER TABLE ops.operations ADD COLUMN adapter_mode text CHECK (adapter_mode IN ('real', 'simulation'));

-- The attempt row is recorded BEFORE the provider create call; a restart finds it and reconciles instead of creating again.
ALTER TABLE ops.operation_attempts
  ADD COLUMN attempt_id      uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN slot_key        text REFERENCES ops.capacity_slots (key),
  ADD COLUMN slot_generation bigint,
  ADD COLUMN status          text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'ready', 'failed', 'cleaned', 'uncertain')),
  ADD COLUMN started_at      timestamptz NOT NULL DEFAULT now();

-- ---------------------------------------------------------------- seed (after the ALTERs: deferred FK events block ALTER TABLE)
-- One row per possible VM (docs/05). The warm slot's provider follows capacity.warm_provider at reserve time.
INSERT INTO ops.capacity_slots (key, provider, role)
SELECT 'elastic-do-' || n, 'digitalocean', 'elastic' FROM generate_series(1, 5) n
UNION ALL
SELECT 'elastic-linode-' || n, 'linode', 'elastic' FROM generate_series(1, 5) n
UNION ALL
VALUES ('warm', 'digitalocean', 'warm'), ('interim-warm-digitalocean', 'digitalocean', 'warm'), ('interim-warm-linode', 'linode', 'warm');

INSERT INTO ops.control_leases (application_key) VALUES ('relief');

-- ---------------------------------------------------------------- internal helpers (no grants)
CREATE FUNCTION ops._audit(p_action text, p_object text, p_old jsonb, p_new jsonb, p_op uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$ INSERT INTO ops.audit_events (source, action, object, old_value, new_value, operation_id) VALUES ('automation', p_action, p_object, p_old, p_new, p_op) $$;

-- Active policy cap for a provider, clamped to the immutable ceiling. No active policy => 0 (fail closed).
CREATE FUNCTION ops._provider_cap(p_provider text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
  SELECT coalesce((SELECT least(5, greatest(0, coalesce((p.configuration #>> ARRAY['capacity', 'max_cloud_vms_per_provider', p_provider])::int, 0)))
                   FROM ops.policy_versions p WHERE p.status = 'active'), 0)
$$;

-- Warm provider: the active policy's capacity.warm_provider, else wherever the warm slot currently sits.
CREATE FUNCTION ops._warm_provider() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
  SELECT coalesce((SELECT p.configuration #>> '{capacity,warm_provider}' FROM ops.policy_versions p WHERE p.status = 'active'),
                  (SELECT s.provider FROM ops.capacity_slots s WHERE s.key = 'warm'))
$$;

-- ---------------------------------------------------------------- lease (docs/07: 120 s, renewed every 20 s)
CREATE FUNCTION ops.assert_lease(p_op uuid, p_gen bigint, p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE l ops.control_leases%ROWTYPE;
BEGIN
  SELECT * INTO l FROM ops.control_leases WHERE application_key = p_app FOR SHARE;
  IF NOT FOUND OR l.holder_operation IS DISTINCT FROM p_op OR l.fencing_generation <> p_gen
     OR l.lease_expires_at IS NULL OR l.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'lease_lost' USING ERRCODE = 'CDR01';
  END IF;
END $$;

-- Returns no row when another operation holds a live lease. An expired lease is taken over with a new
-- generation, which fences the old worker; previous_holder lets reconcile mark that operation reconciling.
CREATE FUNCTION ops.acquire_lease(p_op uuid, p_app text DEFAULT 'relief', p_ttl_seconds integer DEFAULT 120)
RETURNS TABLE (generation bigint, previous_holder uuid, previous_expired boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  l  ops.control_leases%ROWTYPE;
  st text;
  g  bigint;
BEGIN
  IF p_ttl_seconds NOT BETWEEN 10 AND 600 THEN RAISE EXCEPTION 'bad_ttl' USING ERRCODE = 'CDR04'; END IF;
  SELECT o.status INTO st FROM ops.operations o WHERE o.id = p_op;
  IF st IS NULL OR st IN ('succeeded', 'failed', 'cancelled') THEN RAISE EXCEPTION 'operation_not_active' USING ERRCODE = 'CDR04'; END IF;
  SELECT * INTO l FROM ops.control_leases c WHERE c.application_key = p_app FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_application' USING ERRCODE = 'CDR04'; END IF;
  IF l.holder_operation IS NOT NULL AND l.lease_expires_at > clock_timestamp() THEN
    IF l.holder_operation <> p_op THEN RETURN; END IF;
    UPDATE ops.control_leases c SET lease_expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds) WHERE c.application_key = p_app;
    RETURN QUERY SELECT l.fencing_generation, p_op, false;
    RETURN;
  END IF;
  UPDATE ops.control_leases c
     SET holder_operation = p_op, lease_expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds), fencing_generation = c.fencing_generation + 1
   WHERE c.application_key = p_app RETURNING c.fencing_generation INTO g;
  RETURN QUERY SELECT g, l.holder_operation, l.holder_operation IS NOT NULL;
END $$;

CREATE FUNCTION ops.renew_lease(p_op uuid, p_gen bigint, p_app text DEFAULT 'relief', p_ttl_seconds integer DEFAULT 120) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE v timestamptz;
BEGIN
  IF p_ttl_seconds NOT BETWEEN 10 AND 600 THEN RAISE EXCEPTION 'bad_ttl' USING ERRCODE = 'CDR04'; END IF;
  UPDATE ops.control_leases c SET lease_expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds)
   WHERE c.application_key = p_app AND c.holder_operation = p_op AND c.fencing_generation = p_gen AND c.lease_expires_at > clock_timestamp()
  RETURNING c.lease_expires_at INTO v;
  IF NOT FOUND THEN RAISE EXCEPTION 'lease_lost' USING ERRCODE = 'CDR01'; END IF;
  RETURN v;
END $$;

CREATE FUNCTION ops.release_lease(p_op uuid, p_gen bigint, p_app text DEFAULT 'relief') RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
BEGIN
  UPDATE ops.control_leases c SET holder_operation = NULL, lease_expires_at = NULL
   WHERE c.application_key = p_app AND c.holder_operation = p_op AND c.fencing_generation = p_gen;
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------- slots
-- Reserve one slot (free -> reserved) and its instance record. Occupied = every non-free slot of the provider
-- (reserved, bound, releasing, held_uncertain), including warm and interim-warm. While the warm slot is free
-- its place on the warm provider is kept back from elastic reservations (docs/03 warm floor).
-- p_kind: 'elastic' (lowest free elastic key), 'warm' (provider must be capacity.warm_provider),
-- 'interim_warm' (only while the warm slot is held_uncertain, on the other provider).
-- Replays the operation's own reserved/bound slot; refuses a different one (CDR02). No capacity => no rows.
CREATE FUNCTION ops.reserve_slot(p_op uuid, p_lease_gen bigint, p_provider text, p_kind text, p_simulated boolean DEFAULT false, p_app text DEFAULT 'relief')
RETURNS TABLE (reserved_key text, reserved_generation bigint, reserved_instance_id uuid, replayed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  held   ops.capacity_slots%ROWTYPE;
  warm   ops.capacity_slots%ROWTYPE;
  v_key  text;
  v_occ  integer;
  v_cap  integer;
  v_floor integer := 0;
  v_iid  uuid;
  v_gen  bigint;
  v_warm_provider text := ops._warm_provider();
BEGIN
  IF p_provider NOT IN ('digitalocean', 'linode') OR p_kind NOT IN ('warm', 'elastic', 'interim_warm') THEN
    RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04';
  END IF;
  PERFORM ops.assert_lease(p_op, p_lease_gen, p_app);
  -- Serialize every slot decision; ordered, so concurrent callers cannot deadlock.
  PERFORM 1 FROM ops.capacity_slots s ORDER BY s.key FOR UPDATE;

  SELECT * INTO held FROM ops.capacity_slots s WHERE s.lease_operation_id = p_op AND s.state IN ('reserved', 'bound') ORDER BY s.key LIMIT 1;
  IF FOUND THEN
    IF held.provider = p_provider AND (
         (p_kind = 'warm' AND held.key = 'warm') OR (p_kind = 'interim_warm' AND held.key LIKE 'interim-warm-%') OR (p_kind = 'elastic' AND held.key LIKE 'elastic-%')) THEN
      RETURN QUERY SELECT held.key, held.generation, held.bound_instance_id, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'operation_holds_other_slot' USING ERRCODE = 'CDR02';
  END IF;

  SELECT * INTO warm FROM ops.capacity_slots s WHERE s.key = 'warm';
  v_cap := ops._provider_cap(p_provider);
  SELECT count(*) INTO v_occ FROM ops.capacity_slots s WHERE s.provider = p_provider AND s.state <> 'free';

  IF p_kind = 'warm' THEN
    IF v_warm_provider IS DISTINCT FROM p_provider THEN RAISE EXCEPTION 'not_warm_provider' USING ERRCODE = 'CDR04'; END IF;
    IF warm.state <> 'free' THEN RETURN; END IF;
    -- A free warm slot follows the configured warm provider; recount for the provider it moves to.
    IF warm.provider <> p_provider THEN
      UPDATE ops.capacity_slots s SET provider = p_provider WHERE s.key = 'warm';
    END IF;
    v_key := 'warm';
  ELSIF p_kind = 'interim_warm' THEN
    IF warm.state <> 'held_uncertain' OR warm.provider = p_provider THEN RETURN; END IF;
    v_key := 'interim-warm-' || p_provider;
    PERFORM 1 FROM ops.capacity_slots s WHERE s.key = v_key AND s.state = 'free';
    IF NOT FOUND THEN RETURN; END IF;
  ELSE
    IF warm.state = 'free' AND v_warm_provider = p_provider THEN v_floor := 1; END IF;
    SELECT s.key INTO v_key FROM ops.capacity_slots s
     WHERE s.role = 'elastic' AND s.provider = p_provider AND s.state = 'free' ORDER BY s.key LIMIT 1;
    IF v_key IS NULL THEN RETURN; END IF;
  END IF;

  IF v_occ + v_floor + 1 > v_cap THEN RETURN; END IF;

  INSERT INTO ops.instances (slot_key, provider, role, lifecycle_state, slot_state, simulated)
  VALUES (v_key, p_provider, CASE WHEN p_kind = 'elastic' THEN 'elastic' ELSE 'warm' END, 'reserved', 'reserved', p_simulated)
  RETURNING id INTO v_iid;
  UPDATE ops.capacity_slots s
     SET state = 'reserved', generation = s.generation + 1, lease_operation_id = p_op, bound_instance_id = v_iid, updated_at = now()
   WHERE s.key = v_key RETURNING s.generation INTO v_gen;
  PERFORM ops._audit('slot.reserved', 'slot:' || v_key, NULL, jsonb_build_object('provider', p_provider, 'kind', p_kind, 'generation', v_gen, 'simulated', p_simulated), p_op);
  RETURN QUERY SELECT v_key, v_gen, v_iid, false;
END $$;

-- Shared guard: lease, row lock, expected slot generation, allowed states.
CREATE FUNCTION ops._lock_slot(p_op uuid, p_lease_gen bigint, p_key text, p_slot_gen bigint, p_states text[], p_app text) RETURNS ops.capacity_slots
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE s ops.capacity_slots%ROWTYPE;
BEGIN
  PERFORM ops.assert_lease(p_op, p_lease_gen, p_app);
  SELECT * INTO s FROM ops.capacity_slots c WHERE c.key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_slot' USING ERRCODE = 'CDR04'; END IF;
  IF s.generation <> p_slot_gen THEN RAISE EXCEPTION 'slot_generation_mismatch' USING ERRCODE = 'CDR02'; END IF;
  IF s.state <> ALL (p_states) THEN RAISE EXCEPTION 'slot_state_%', s.state USING ERRCODE = 'CDR02'; END IF;
  RETURN s;
END $$;

-- reserved -> bound once the provider resource exists.
CREATE FUNCTION ops.bind_slot(p_op uuid, p_lease_gen bigint, p_key text, p_slot_gen bigint, p_provider_resource_id text, p_public_ip text,
                              p_vcpu integer, p_memory_mb integer, p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE s ops.capacity_slots%ROWTYPE;
BEGIN
  IF coalesce(p_provider_resource_id, '') = '' THEN RAISE EXCEPTION 'resource_id_required' USING ERRCODE = 'CDR04'; END IF;
  s := ops._lock_slot(p_op, p_lease_gen, p_key, p_slot_gen, ARRAY['reserved'], p_app);
  IF s.lease_operation_id IS DISTINCT FROM p_op THEN RAISE EXCEPTION 'slot_owned_by_other_operation' USING ERRCODE = 'CDR02'; END IF;
  UPDATE ops.instances i SET provider_resource_id = p_provider_resource_id, public_ip = p_public_ip, vcpu = p_vcpu, memory_mb = p_memory_mb,
         lifecycle_state = 'provisioning', slot_state = 'bound', last_seen_at = now()
   WHERE i.id = s.bound_instance_id;
  UPDATE ops.capacity_slots c SET state = 'bound', updated_at = now() WHERE c.key = p_key;
  PERFORM ops._audit('slot.bound', 'slot:' || p_key, NULL, jsonb_build_object('generation', p_slot_gen), p_op);
END $$;

-- Existence unknown (timeout, unreachable API, unknown tagged resource): the slot stays counted.
CREATE FUNCTION ops.mark_slot_uncertain(p_op uuid, p_lease_gen bigint, p_key text, p_slot_gen bigint, p_reason text, p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE s ops.capacity_slots%ROWTYPE;
BEGIN
  s := ops._lock_slot(p_op, p_lease_gen, p_key, p_slot_gen, ARRAY['reserved', 'bound', 'releasing'], p_app);
  UPDATE ops.instances i SET lifecycle_state = 'unknown', slot_state = 'held_uncertain' WHERE i.id = s.bound_instance_id AND i.lifecycle_state <> 'deleted';
  UPDATE ops.capacity_slots c SET state = 'held_uncertain', updated_at = now() WHERE c.key = p_key;
  PERFORM ops._audit('slot.held_uncertain', 'slot:' || p_key, jsonb_build_object('state', s.state), jsonb_build_object('reason', left(coalesce(p_reason, ''), 200)), p_op);
END $$;

-- bound|reserved -> releasing (deletion starts). The warm-role slots are protected: only standby_repair and
-- reconcile may release them, and scale_in only the surplus one while another warm-role slot is bound.
CREATE FUNCTION ops.begin_slot_release(p_op uuid, p_lease_gen bigint, p_key text, p_slot_gen bigint, p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  s ops.capacity_slots%ROWTYPE;
  k text;
BEGIN
  s := ops._lock_slot(p_op, p_lease_gen, p_key, p_slot_gen, ARRAY['reserved', 'bound'], p_app);
  IF s.role = 'warm' THEN
    SELECT o.kind INTO k FROM ops.operations o WHERE o.id = p_op;
    IF k IS NULL OR k NOT IN ('standby_repair', 'reconcile') THEN
      PERFORM 1 FROM ops.capacity_slots c WHERE c.role = 'warm' AND c.state = 'bound' AND c.key <> p_key;
      IF k IS DISTINCT FROM 'scale_in' OR NOT FOUND THEN RAISE EXCEPTION 'warm_slot_protected' USING ERRCODE = 'CDR02'; END IF;
    END IF;
  END IF;
  UPDATE ops.instances i SET lifecycle_state = 'deleting', slot_state = 'releasing' WHERE i.id = s.bound_instance_id;
  UPDATE ops.capacity_slots c SET state = 'releasing', lease_operation_id = p_op, updated_at = now() WHERE c.key = p_key;
  PERFORM ops._audit('slot.releasing', 'slot:' || p_key, jsonb_build_object('state', s.state), NULL, p_op);
END $$;

-- Evidence must say the provider API confirmed absence. A timeout is not evidence.
CREATE FUNCTION ops._require_absence(p_evidence jsonb) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog
AS $$
BEGIN
  IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
     OR p_evidence ->> 'confirmed_absent' IS DISTINCT FROM 'true'
     OR p_evidence ->> 'source' IS DISTINCT FROM 'provider_api'
     OR p_evidence ->> 'observed_at' IS NULL THEN
    RAISE EXCEPTION 'absence_not_confirmed' USING ERRCODE = 'CDR04';
  END IF;
  PERFORM (p_evidence ->> 'observed_at')::timestamptz;
END $$;

CREATE FUNCTION ops._free_slot(p_key text, p_instance uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
BEGIN
  UPDATE ops.instances i SET lifecycle_state = 'deleted', slot_state = 'free', routing_mode = 'none', routing_weight = 0 WHERE i.id = p_instance;
  UPDATE ops.capacity_slots c SET state = 'free', bound_instance_id = NULL, lease_operation_id = NULL, updated_at = now() WHERE c.key = p_key;
END $$;

-- releasing -> free, only with confirmed absence.
CREATE FUNCTION ops.release_slot(p_op uuid, p_lease_gen bigint, p_key text, p_slot_gen bigint, p_evidence jsonb, p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE s ops.capacity_slots%ROWTYPE;
BEGIN
  PERFORM ops._require_absence(p_evidence);
  s := ops._lock_slot(p_op, p_lease_gen, p_key, p_slot_gen, ARRAY['releasing'], p_app);
  PERFORM ops._free_slot(p_key, s.bound_instance_id);
  PERFORM ops._audit('slot.released', 'slot:' || p_key, jsonb_build_object('state', 'releasing'), p_evidence, p_op);
END $$;

-- held_uncertain -> free | bound, reconcile only (docs/05). 'free' needs confirmed absence; 'bound' needs the found resource.
CREATE FUNCTION ops.resolve_held_slot(p_op uuid, p_lease_gen bigint, p_key text, p_slot_gen bigint, p_outcome text, p_evidence jsonb,
                                      p_provider_resource_id text DEFAULT NULL, p_public_ip text DEFAULT NULL, p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  s ops.capacity_slots%ROWTYPE;
  k text;
BEGIN
  IF p_outcome NOT IN ('free', 'bound') THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  SELECT o.kind INTO k FROM ops.operations o WHERE o.id = p_op;
  IF k IS DISTINCT FROM 'reconcile' THEN RAISE EXCEPTION 'reconcile_only' USING ERRCODE = 'CDR02'; END IF;
  IF p_outcome = 'free' THEN
    PERFORM ops._require_absence(p_evidence);
  ELSIF coalesce(p_provider_resource_id, '') = '' OR p_evidence ->> 'exists' IS DISTINCT FROM 'true' OR p_evidence ->> 'source' IS DISTINCT FROM 'provider_api' THEN
    RAISE EXCEPTION 'existence_not_confirmed' USING ERRCODE = 'CDR04';
  END IF;
  s := ops._lock_slot(p_op, p_lease_gen, p_key, p_slot_gen, ARRAY['held_uncertain'], p_app);
  IF p_outcome = 'free' THEN
    PERFORM ops._free_slot(p_key, s.bound_instance_id);
  ELSE
    -- Found but health unknown: 'failed' so the workflow redeploys and checks readiness before use.
    UPDATE ops.instances i SET provider_resource_id = p_provider_resource_id, public_ip = coalesce(p_public_ip, i.public_ip), lifecycle_state = 'failed', slot_state = 'bound', last_seen_at = now()
     WHERE i.id = s.bound_instance_id;
    UPDATE ops.capacity_slots c SET state = 'bound', lease_operation_id = p_op, updated_at = now() WHERE c.key = p_key;
  END IF;
  PERFORM ops._audit('slot.resolved_' || p_outcome, 'slot:' || p_key, jsonb_build_object('state', 'held_uncertain'), p_evidence, p_op);
END $$;

-- Advisory pick for the next elastic VM: fewest elastic slots first (so providers alternate and scale-in newest-first keeps
-- the balance), the non-warm provider on ties; skips providers at cap (warm floor included) or listed unavailable.
-- reserve_slot re-checks atomically.
CREATE FUNCTION ops.next_elastic_provider(p_unavailable text[] DEFAULT '{}') RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
  WITH w AS (SELECT state FROM ops.capacity_slots WHERE key = 'warm'),
  p AS (
    SELECT v.provider,
           ops._provider_cap(v.provider) AS cap,
           (SELECT count(*) FROM ops.capacity_slots s WHERE s.provider = v.provider AND s.state <> 'free') AS occ,
           (SELECT count(*) FROM ops.capacity_slots s WHERE s.provider = v.provider AND s.role = 'elastic' AND s.state <> 'free') AS elastic,
           (SELECT CASE WHEN w.state = 'free' AND ops._warm_provider() = v.provider THEN 1 ELSE 0 END FROM w) AS floor,
           (ops._warm_provider() = v.provider) AS is_warm
      FROM (VALUES ('digitalocean'), ('linode')) v (provider)
  )
  SELECT p.provider FROM p
   WHERE p.occ + p.floor + 1 <= p.cap AND p.provider <> ALL (p_unavailable)
     AND EXISTS (SELECT 1 FROM ops.capacity_slots s WHERE s.provider = p.provider AND s.role = 'elastic' AND s.state = 'free')
   ORDER BY p.elastic, p.is_warm, p.provider LIMIT 1
$$;

-- Scale-in candidate: the newest bound elastic slot. Warm-role slots are never candidates.
CREATE FUNCTION ops.scale_in_candidate() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
  SELECT s.key FROM ops.capacity_slots s JOIN ops.instances i ON i.id = s.bound_instance_id
   WHERE s.role = 'elastic' AND s.state = 'bound' ORDER BY i.created_at DESC, s.key DESC LIMIT 1
$$;

-- ---------------------------------------------------------------- attempts
-- Record the attempt before the provider create call. created = false means this (operation, attempt) already
-- started (restart): reconcile by tags, do not create again. Deadline and first checkpoint come from the
-- policy version the operation captured.
CREATE FUNCTION ops.start_attempt(p_op uuid, p_lease_gen bigint, p_attempt integer, p_provider text, p_slot_key text, p_slot_gen bigint, p_app text DEFAULT 'relief')
RETURNS TABLE (attempt_id uuid, created boolean, deadline_at timestamptz, checkpoint_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  s   ops.capacity_slots%ROWTYPE;
  pol jsonb;
  v_id uuid;
BEGIN
  IF p_provider NOT IN ('digitalocean', 'linode') THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  s := ops._lock_slot(p_op, p_lease_gen, p_slot_key, p_slot_gen, ARRAY['reserved', 'bound'], p_app);
  IF s.lease_operation_id IS DISTINCT FROM p_op OR s.provider <> p_provider THEN RAISE EXCEPTION 'slot_owned_by_other_operation' USING ERRCODE = 'CDR02'; END IF;
  SELECT p.configuration -> 'provisioning' INTO pol FROM ops.policy_versions p JOIN ops.operations o ON o.policy_version = p.version WHERE o.id = p_op;
  IF pol IS NULL THEN RAISE EXCEPTION 'policy_not_found' USING ERRCODE = 'CDR04'; END IF;
  INSERT INTO ops.operation_attempts AS a (operation_id, attempt, provider, slot_key, slot_generation, checkpoint_at, deadline_at)
  VALUES (p_op, p_attempt, p_provider, p_slot_key, p_slot_gen,
          now() + make_interval(secs => (pol #>> '{readiness_checkpoints_seconds,0}')::int),
          now() + make_interval(secs => (pol ->> 'readiness_deadline_seconds')::int))
  ON CONFLICT (operation_id, attempt) DO NOTHING
  RETURNING a.attempt_id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT a.attempt_id, true, a.deadline_at, a.checkpoint_at FROM ops.operation_attempts a WHERE a.attempt_id = v_id;
  ELSE
    RETURN QUERY SELECT a.attempt_id, false, a.deadline_at, a.checkpoint_at FROM ops.operation_attempts a WHERE a.operation_id = p_op AND a.attempt = p_attempt;
  END IF;
END $$;

-- started -> ready|failed|uncertain; failed -> cleaned|uncertain; uncertain -> ready|failed|cleaned. ready and cleaned are final.
CREATE FUNCTION ops.finish_attempt(p_op uuid, p_lease_gen bigint, p_attempt integer, p_status text, p_error_code text DEFAULT NULL, p_result_refs jsonb DEFAULT NULL, p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE cur text;
BEGIN
  PERFORM ops.assert_lease(p_op, p_lease_gen, p_app);
  SELECT a.status INTO cur FROM ops.operation_attempts a WHERE a.operation_id = p_op AND a.attempt = p_attempt FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_attempt' USING ERRCODE = 'CDR04'; END IF;
  IF NOT (   (cur = 'started'   AND p_status IN ('ready', 'failed', 'uncertain'))
          OR (cur = 'failed'    AND p_status IN ('cleaned', 'uncertain'))
          OR (cur = 'uncertain' AND p_status IN ('ready', 'failed', 'cleaned'))) THEN
    RAISE EXCEPTION 'attempt_transition_%_%', cur, p_status USING ERRCODE = 'CDR03';
  END IF;
  UPDATE ops.operation_attempts a SET status = p_status, error_code = left(p_error_code, 100), result_refs = coalesce(p_result_refs, a.result_refs)
   WHERE a.operation_id = p_op AND a.attempt = p_attempt;
END $$;

-- ---------------------------------------------------------------- operation projection
-- The one writer of operation status/step and its event row for automation (docs/05 transitions, docs/06 events).
-- Returns the event sequence. A terminal no-op (stale intent, refused scale-in) may succeed from queued/running
-- with outcome.noop_reason set (docs/06).
CREATE FUNCTION ops._operation_transition_ok(cur text, new text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN cur = new THEN cur NOT IN ('succeeded', 'failed', 'cancelled')
    WHEN cur = 'queued' THEN new = 'running'
    WHEN cur = 'running' THEN new IN ('waiting', 'verifying', 'paused', 'reconciling', 'cancelling', 'failed')
    WHEN cur IN ('waiting', 'verifying', 'paused', 'reconciling') THEN new = 'running' OR (new = 'failed' AND cur <> 'paused') OR (cur = 'verifying' AND new = 'succeeded')
    WHEN cur = 'cancelling' THEN new = 'cancelled'
    ELSE false
  END
$$;

CREATE FUNCTION ops.advance_operation(p_op uuid, p_status text, p_step text, p_event_type text, p_message text DEFAULT NULL, p_outcome jsonb DEFAULT NULL,
                                      p_source text DEFAULT 'automation', p_execution_id text DEFAULT NULL, p_adapter_mode text DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  o   ops.operations%ROWTYPE;
  new text;
  seq bigint;
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
  IF o.stackstorm_execution_id IS NOT NULL AND p_execution_id IS NOT NULL AND o.stackstorm_execution_id <> p_execution_id THEN RAISE EXCEPTION 'execution_id_changed' USING ERRCODE = 'CDR04'; END IF;
  UPDATE ops.operations x
     SET status = new, current_step = coalesce(p_step, x.current_step), updated_at = now(),
         adapter_mode = coalesce(x.adapter_mode, p_adapter_mode),
         stackstorm_execution_id = coalesce(x.stackstorm_execution_id, p_execution_id),
         outcome = coalesce(p_outcome, x.outcome),
         finished_at = CASE WHEN new IN ('succeeded', 'failed', 'cancelled') THEN now() ELSE x.finished_at END
   WHERE x.id = p_op;
  INSERT INTO ops.operation_events (operation_id, event_type, status, step, message, source)
  VALUES (p_op, p_event_type, new, left(p_step, 200), left(p_message, 2000), p_source) RETURNING sequence INTO seq;
  RETURN seq;
END $$;

-- ---------------------------------------------------------------- grants
REVOKE ALL ON FUNCTION
  ops.assert_lease(uuid, bigint, text), ops.acquire_lease(uuid, text, integer), ops.renew_lease(uuid, bigint, text, integer), ops.release_lease(uuid, bigint, text),
  ops.reserve_slot(uuid, bigint, text, text, boolean, text), ops.bind_slot(uuid, bigint, text, bigint, text, text, integer, integer, text),
  ops.mark_slot_uncertain(uuid, bigint, text, bigint, text, text), ops.begin_slot_release(uuid, bigint, text, bigint, text),
  ops.release_slot(uuid, bigint, text, bigint, jsonb, text), ops.resolve_held_slot(uuid, bigint, text, bigint, text, jsonb, text, text, text),
  ops.next_elastic_provider(text[]), ops.scale_in_candidate(),
  ops.start_attempt(uuid, bigint, integer, text, text, bigint, text), ops.finish_attempt(uuid, bigint, integer, text, text, jsonb, text),
  ops.advance_operation(uuid, text, text, text, text, jsonb, text, text, text),
  ops._audit(text, text, jsonb, jsonb, uuid), ops._provider_cap(text), ops._warm_provider(), ops._lock_slot(uuid, bigint, text, bigint, text[], text),
  ops._require_absence(jsonb), ops._free_slot(text, uuid), ops._operation_transition_ok(text, text)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  ops.assert_lease(uuid, bigint, text), ops.acquire_lease(uuid, text, integer), ops.renew_lease(uuid, bigint, text, integer), ops.release_lease(uuid, bigint, text),
  ops.reserve_slot(uuid, bigint, text, text, boolean, text), ops.bind_slot(uuid, bigint, text, bigint, text, text, integer, integer, text),
  ops.mark_slot_uncertain(uuid, bigint, text, bigint, text, text), ops.begin_slot_release(uuid, bigint, text, bigint, text),
  ops.release_slot(uuid, bigint, text, bigint, jsonb, text), ops.resolve_held_slot(uuid, bigint, text, bigint, text, jsonb, text, text, text),
  ops.next_elastic_provider(text[]), ops.scale_in_candidate(),
  ops.start_attempt(uuid, bigint, integer, text, text, bigint, text), ops.finish_attempt(uuid, bigint, integer, text, text, jsonb, text),
  ops.advance_operation(uuid, text, text, text, text, jsonb, text, text, text)
  TO dr_automation;

-- Capacity tables are written only through the functions above (SECURITY DEFINER, owned by the migration user).
REVOKE INSERT, UPDATE, DELETE ON ops.capacity_slots, ops.instances, ops.control_leases FROM dr_ops;
GRANT SELECT ON ops.capacity_slots, ops.instances, ops.control_leases TO dr_automation;
