-- P4.1 review fixes. (B) docs/07: only reconcile recovers an expired lease; any other operation kind gets a
-- slot conflict (CDR02) and must wait for reconcile. (D) operation_attempts is written only through the
-- ops.* functions of 0009, so the management API role (dr_ops) loses write access to it.

CREATE OR REPLACE FUNCTION ops.acquire_lease(p_op uuid, p_app text DEFAULT 'relief', p_ttl_seconds integer DEFAULT 120)
RETURNS TABLE (generation bigint, previous_holder uuid, previous_expired boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  l  ops.control_leases%ROWTYPE;
  st text;
  k  text;
  g  bigint;
BEGIN
  IF p_ttl_seconds NOT BETWEEN 10 AND 600 THEN RAISE EXCEPTION 'bad_ttl' USING ERRCODE = 'CDR04'; END IF;
  SELECT o.status, o.kind INTO st, k FROM ops.operations o WHERE o.id = p_op;
  IF st IS NULL OR st IN ('succeeded', 'failed', 'cancelled') THEN RAISE EXCEPTION 'operation_not_active' USING ERRCODE = 'CDR04'; END IF;
  SELECT * INTO l FROM ops.control_leases c WHERE c.application_key = p_app FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_application' USING ERRCODE = 'CDR04'; END IF;
  IF l.holder_operation IS NOT NULL AND l.lease_expires_at > clock_timestamp() THEN
    IF l.holder_operation <> p_op THEN RETURN; END IF;
    UPDATE ops.control_leases c SET lease_expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds) WHERE c.application_key = p_app;
    RETURN QUERY SELECT l.fencing_generation, p_op, false;
    RETURN;
  END IF;
  -- Expired but never released: the previous worker may still have side effects in flight (docs/07).
  IF l.holder_operation IS NOT NULL AND l.holder_operation <> p_op AND k <> 'reconcile' THEN
    RAISE EXCEPTION 'lease_expired_reconcile_only' USING ERRCODE = 'CDR02';
  END IF;
  UPDATE ops.control_leases c
     SET holder_operation = p_op, lease_expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds), fencing_generation = c.fencing_generation + 1
   WHERE c.application_key = p_app RETURNING c.fencing_generation INTO g;
  RETURN QUERY SELECT g, l.holder_operation, l.holder_operation IS NOT NULL;
END $$;

REVOKE INSERT, UPDATE, DELETE ON ops.operation_attempts FROM dr_ops;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.operation_attempts TO dr_automation;
