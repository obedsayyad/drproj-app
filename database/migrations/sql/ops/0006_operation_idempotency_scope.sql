-- Operator idempotency keys are scoped by (route_template, key); a key is never reusable across
-- routes. Operation rows are never purged, so keys do not expire.
ALTER TABLE ops.operations ADD COLUMN route_template text;

UPDATE ops.operations SET route_template = CASE kind
  WHEN 'apply_policy' THEN '/api/policies'
  WHEN 'create_backup' THEN '/api/backups'
  WHEN 'verify_backup' THEN '/api/backups/{id}/verify'
  WHEN 'restore_application' THEN '/api/restores'
  WHEN 'start_load_test' THEN '/api/tests'
  WHEN 'stop_load_test' THEN '/api/tests/{id}/stop'
  ELSE '/api/operations' END
WHERE idempotency_key IS NOT NULL;

ALTER TABLE ops.operations DROP CONSTRAINT operations_idempotency_key_key;
ALTER TABLE ops.operations ADD CONSTRAINT operations_route_key_unique UNIQUE (route_template, idempotency_key);
ALTER TABLE ops.operations ADD CONSTRAINT operations_key_route_check CHECK ((idempotency_key IS NULL) = (route_template IS NULL));
