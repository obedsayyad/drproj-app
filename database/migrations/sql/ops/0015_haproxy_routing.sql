-- P6.2 real HAProxy routing adapter (docs/04, docs/07, docs/08).
-- ops.record_haproxy_command: audit record for every Runtime API mutation (lease asserted inside).
-- ops.incidents.baseline_p95_seconds: median app p95 over the 10 minutes before the primary failure, used by the failback p95 gate.
-- SECURITY DEFINER, EXECUTE for dr_automation only, errors CDR01..CDR04.

ALTER TABLE ops.incidents ADD COLUMN baseline_p95_seconds double precision CHECK (baseline_p95_seconds IS NULL OR baseline_p95_seconds > 0);

CREATE FUNCTION ops.record_haproxy_command(p_op uuid, p_lease_gen bigint, p_command text, p_old jsonb, p_new jsonb, p_dump text,
                                           p_app text DEFAULT 'relief') RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE v_server text;
BEGIN
  PERFORM ops.assert_lease(p_op, p_lease_gen, p_app);
  v_server := substring(p_command FROM '^set server be_app/([A-Za-z0-9_-]{1,32}) ');
  IF v_server IS NULL OR p_dump !~ '^[0-9TZ]+\.state$' THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  PERFORM ops._audit('haproxy.command', 'lb:be_app/' || v_server,
                     jsonb_build_object('state', p_old),
                     jsonb_build_object('command', btrim(p_command, E' \n'), 'state', p_new, 'dump', p_dump, 'adapter_mode', 'real'), p_op);
END $$;

-- Sets the baseline on the open incident with this fingerprint; false when none is open (nothing is invented).
CREATE FUNCTION ops.set_incident_baseline(p_fingerprint text, p_baseline_p95_seconds double precision) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE n integer;
BEGIN
  IF p_baseline_p95_seconds IS NULL OR p_baseline_p95_seconds <= 0 THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  UPDATE ops.incidents SET baseline_p95_seconds = p_baseline_p95_seconds WHERE fingerprint = p_fingerprint AND state = 'open';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;

REVOKE ALL ON FUNCTION ops.record_haproxy_command(uuid, bigint, text, jsonb, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.set_incident_baseline(text, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.record_haproxy_command(uuid, bigint, text, jsonb, jsonb, text, text) TO dr_automation;
GRANT EXECUTE ON FUNCTION ops.set_incident_baseline(text, double precision) TO dr_automation;
