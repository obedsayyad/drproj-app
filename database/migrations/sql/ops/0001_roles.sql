-- Group roles only. Login users/passwords are created by the operator out-of-band
-- and granted one of these roles; no credentials live in source.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['dr_app_runtime', 'dr_ops', 'dr_backup', 'dr_restore'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA ops TO dr_ops;

-- The migration user must be able to SET ROLE to dr_restore (required for the ownership transfer
-- in app/0001) and to keep altering tables that a restore swaps in owned by dr_restore.
-- dr_restore needs CREATE on the database to rename and re-create schema app (docs/09 step 7).
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT dr_restore TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  ELSE
    EXECUTE format('GRANT dr_restore TO %I', current_user);
  END IF;
  EXECUTE format('GRANT CREATE ON DATABASE %I TO dr_restore', current_database());
END $$;
