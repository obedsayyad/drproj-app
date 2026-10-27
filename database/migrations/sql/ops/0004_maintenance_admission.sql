-- Write admission (docs/06, docs/09). Reads the maintenance flag with a shared row lock, so the
-- check and the write are atomic with respect to a flag flip: an UPDATE of ops.runtime_flags waits
-- for in-flight writers to commit (drain), and a writer that meets an uncommitted flip waits for it.
-- VOLATILE because SELECT ... FOR SHARE is not allowed in a STABLE function.
CREATE FUNCTION ops.app_admit_write()
RETURNS TABLE (maintenance boolean, generation bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$ SELECT f.maintenance, f.generation FROM ops.runtime_flags f WHERE f.singleton FOR SHARE $$;

REVOKE ALL ON FUNCTION ops.app_admit_write() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.app_admit_write() TO dr_app_runtime;
