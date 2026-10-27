-- Phase 2 (management API). docs/05, docs/06.

-- Typed inputs of an operation (e.g. backup_id, policy_version, test_run_id). Never secrets or paths.
ALTER TABLE ops.operations ADD COLUMN parameters jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Size of the app schema after the isolated restore test; the restore headroom check needs it.
ALTER TABLE ops.backups ADD COLUMN restored_bytes bigint CHECK (restored_bytes >= 0);

ALTER TABLE ops.test_runs ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- Durable operation progress; `sequence` is the SSE event id (Last-Event-ID replay).
CREATE TABLE ops.operation_events (
  sequence     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES ops.operations (id),
  event_type   text NOT NULL CHECK (char_length(event_type) <= 100),
  status       text CHECK (status IN ('queued', 'running', 'waiting', 'verifying', 'paused', 'reconciling', 'cancelling', 'cancelled', 'succeeded', 'failed')),
  step         text CHECK (char_length(step) <= 200),
  message      text CHECK (char_length(message) <= 2000),
  source       text NOT NULL CHECK (source IN ('dashboard', 'automation', 'reconciliation', 'alertmanager', 'timer')),
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operation_events_operation_idx ON ops.operation_events (operation_id, sequence);

-- One policy activation at a time.
CREATE UNIQUE INDEX policy_versions_one_pending ON ops.policy_versions ((true)) WHERE status = 'pending';

-- Finish a pending activation atomically (called by the apply_policy workflow). On success the
-- old active version is superseded; on failure the old version stays active (docs/03 step 7).
CREATE FUNCTION ops.finish_policy_activation(p_version integer, p_success boolean, p_result jsonb)
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, ops
AS $$
DECLARE
  v_status text;
  v_old integer;
BEGIN
  SELECT status INTO v_status FROM ops.policy_versions WHERE version = p_version FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'policy version % does not exist', p_version;
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'policy version % is %, not pending', p_version, v_status;
  END IF;
  IF p_success THEN
    UPDATE ops.policy_versions SET status = 'superseded' WHERE status = 'active' RETURNING version INTO v_old;
    UPDATE ops.policy_versions
       SET status = 'active', activation_phase = 'completed', activated_at = now(), apply_result = p_result
     WHERE version = p_version;
  ELSE
    UPDATE ops.policy_versions SET status = 'failed', apply_result = p_result WHERE version = p_version;
  END IF;
  INSERT INTO ops.audit_events (source, action, object, old_value, new_value)
  VALUES ('automation', CASE WHEN p_success THEN 'policy.activated' ELSE 'policy.activation_failed' END,
          'policy:' || p_version, jsonb_build_object('active_version', v_old), p_result);
  RETURN CASE WHEN p_success THEN 'active' ELSE 'failed' END;
END $$;

REVOKE ALL ON FUNCTION ops.finish_policy_activation(integer, boolean, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.finish_policy_activation(integer, boolean, jsonb) TO dr_ops;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.operation_events TO dr_ops;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO dr_ops;
