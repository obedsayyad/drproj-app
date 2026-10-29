-- Load-test status projection (P6.3). dr_automation has no table grant on ops.test_runs; the k6 workflows project the run's status, results
-- location and summary through this one function, keyed by the run id. Terminal rows are never changed again.
CREATE FUNCTION ops.update_test_run(p_run uuid, p_status text, p_results_location text DEFAULT NULL, p_summary jsonb DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  t ops.test_runs%ROWTYPE;
BEGIN
  IF p_status NOT IN ('running', 'cancelling', 'cancelled', 'succeeded', 'failed') THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  SELECT * INTO t FROM ops.test_runs x WHERE x.id = p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04'; END IF;
  IF t.status IN ('cancelled', 'succeeded', 'failed') THEN RETURN t.id; END IF;
  UPDATE ops.test_runs SET
    status = p_status,
    results_location = COALESCE(p_results_location, results_location),
    summary = COALESCE(p_summary, summary),
    started_at = CASE WHEN p_status = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
    finished_at = CASE WHEN p_status IN ('cancelled', 'succeeded', 'failed') THEN now() ELSE finished_at END
  WHERE id = t.id;
  RETURN t.id;
END $$;

REVOKE ALL ON FUNCTION ops.update_test_run(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.update_test_run(uuid, text, text, jsonb) TO dr_automation;
GRANT SELECT ON ops.test_runs TO dr_automation;
