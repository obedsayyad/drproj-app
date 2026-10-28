-- P6.2-FIX-1 pre-mutation intent for HAProxy Runtime API commands (docs/04, docs/08).
-- A `pending` row is written inside the same database call that asserts the lease, BEFORE the command is sent. After the dump it is
-- completed (`applied`, dump name, audit event). If the completion fails the routing change stands (HAProxy is never rolled back) and the
-- reconcile pass backfills the pending row from the live membership / local state store (`applied`) or closes it `abandoned` when the
-- command's effect is not observable (it was never sent, or a later command superseded it). Errors CDR01..CDR04; EXECUTE for dr_automation only.

CREATE TABLE ops.haproxy_commands (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES ops.operations (id),
  generation   bigint NOT NULL,
  command      text NOT NULL CHECK (command ~ '^set server be_app/[A-Za-z0-9_-]{1,32} (state|weight|addr) [A-Za-z0-9. %-]{1,64}\n?$'),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'abandoned')),
  dump         text CHECK (dump IS NULL OR dump ~ '^[0-9TZ]+\.state$'),
  backfilled   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status = 'applied') = (dump IS NOT NULL))
);
CREATE INDEX haproxy_commands_pending_idx ON ops.haproxy_commands (created_at) WHERE status = 'pending';

-- Lease assert + intent row in ONE call. Returns the row id the caller completes after the dump.
CREATE FUNCTION ops.begin_haproxy_command(p_op uuid, p_lease_gen bigint, p_command text, p_app text DEFAULT 'relief') RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM ops.assert_lease(p_op, p_lease_gen, p_app);
  IF p_command !~ '^set server be_app/[A-Za-z0-9_-]{1,32} (state|weight|addr) ' THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  INSERT INTO ops.haproxy_commands (operation_id, generation, command) VALUES (p_op, p_lease_gen, btrim(p_command, E' \n')) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Completion after the command was sent and dumped. Deliberately no lease assert: the change already stands and must be recorded.
CREATE FUNCTION ops.complete_haproxy_command(p_id uuid, p_old jsonb, p_new jsonb, p_dump text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE c ops.haproxy_commands%ROWTYPE;
BEGIN
  IF p_dump IS NULL OR p_dump !~ '^[0-9TZ]+\.state$' THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  UPDATE ops.haproxy_commands SET status = 'applied', dump = p_dump, completed_at = now() WHERE id = p_id AND status = 'pending' RETURNING * INTO c;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_pending' USING ERRCODE = 'CDR02'; END IF;
  PERFORM ops._audit('haproxy.command', 'lb:be_app/' || substring(c.command FROM '^set server be_app/([A-Za-z0-9_-]{1,32}) '),
                     jsonb_build_object('state', p_old),
                     jsonb_build_object('command', c.command, 'state', p_new, 'dump', p_dump, 'adapter_mode', 'real'), c.operation_id);
END $$;

-- Reconcile only (lease asserted for the reconcile operation): close a pending row left by a dead worker.
-- p_applied true -> applied with the dump holding the observed state; false -> abandoned (effect not observable).
CREATE FUNCTION ops.backfill_haproxy_command(p_op uuid, p_lease_gen bigint, p_id uuid, p_applied boolean, p_dump text DEFAULT NULL, p_new jsonb DEFAULT NULL, p_app text DEFAULT 'relief') RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE c ops.haproxy_commands%ROWTYPE;
BEGIN
  PERFORM ops._require_reconcile(p_op);
  PERFORM ops.assert_lease(p_op, p_lease_gen, p_app);
  IF p_applied AND (p_dump IS NULL OR p_dump !~ '^[0-9TZ]+\.state$') THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  UPDATE ops.haproxy_commands SET status = CASE WHEN p_applied THEN 'applied' ELSE 'abandoned' END, dump = CASE WHEN p_applied THEN p_dump END,
         backfilled = true, completed_at = now()
   WHERE id = p_id AND status = 'pending' RETURNING * INTO c;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM ops._audit(CASE WHEN p_applied THEN 'haproxy.command' ELSE 'haproxy.command_abandoned' END,
                     'lb:be_app/' || substring(c.command FROM '^set server be_app/([A-Za-z0-9_-]{1,32}) '), NULL,
                     jsonb_build_object('command', c.command, 'state', p_new, 'dump', p_dump, 'adapter_mode', 'real', 'backfilled', true), c.operation_id);
  RETURN true;
END $$;

-- Same validation as ops.set_routing, no write: apply_routing sends the HAProxy commands after this and commits ops.set_routing as the completion step.
CREATE FUNCTION ops.check_routing(p_op uuid, p_lease_gen bigint, p_key text, p_slot_gen bigint, p_mode text, p_weight integer DEFAULT NULL, p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  s ops.capacity_slots%ROWTYPE;
  i ops.instances%ROWTYPE;
BEGIN
  IF p_mode NOT IN ('none', 'backup', 'active', 'draining') OR p_weight NOT BETWEEN 0 AND 256 THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  s := ops._lock_slot(p_op, p_lease_gen, p_key, p_slot_gen, ARRAY['bound', 'releasing'], p_app);
  SELECT * INTO i FROM ops.instances x WHERE x.id = s.bound_instance_id;
  IF p_mode IN ('active', 'backup', 'draining') AND i.lifecycle_state NOT IN ('ready', 'draining') THEN RAISE EXCEPTION 'instance_not_ready' USING ERRCODE = 'CDR03'; END IF;
END $$;

REVOKE ALL ON FUNCTION ops.check_routing(uuid, bigint, text, bigint, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.check_routing(uuid, bigint, text, bigint, text, integer, text) TO dr_automation;

REVOKE ALL ON FUNCTION ops.begin_haproxy_command(uuid, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.complete_haproxy_command(uuid, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.backfill_haproxy_command(uuid, bigint, uuid, boolean, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.begin_haproxy_command(uuid, bigint, text, text) TO dr_automation;
GRANT EXECUTE ON FUNCTION ops.complete_haproxy_command(uuid, jsonb, jsonb, text) TO dr_automation;
GRANT EXECUTE ON FUNCTION ops.backfill_haproxy_command(uuid, bigint, uuid, boolean, text, jsonb, text) TO dr_automation;
GRANT SELECT ON ops.haproxy_commands TO dr_automation;
