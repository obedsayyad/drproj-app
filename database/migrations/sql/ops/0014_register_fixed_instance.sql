-- Registers the fixed, self-hosted primary VM in ops.instances (DEPLOY-PRIMARY). Cloud VMs enter only through the capacity slot functions;
-- the primary has no slot, so this narrow, idempotent upsert is its only write path for the StackStorm/automation login.
-- It records inventory facts only: routing stays 'none' (HAProxy routing is a later phase) and simulated is always false.
CREATE FUNCTION ops.register_fixed_instance(p_role text, p_public_ip text, p_image_digest text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_role IS DISTINCT FROM 'primary' OR p_public_ip IS NULL OR p_public_ip !~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
     OR p_image_digest IS NULL OR p_image_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04';
  END IF;
  INSERT INTO ops.instances (provider, provider_resource_id, role, public_ip, image_digest, lifecycle_state, routing_mode, simulated, last_seen_at)
  VALUES ('self_hosted', 'primary', 'primary', p_public_ip, p_image_digest, 'ready', 'none', false, now())
  ON CONFLICT (provider, provider_resource_id) DO UPDATE
    SET public_ip = EXCLUDED.public_ip, image_digest = EXCLUDED.image_digest, lifecycle_state = 'ready', simulated = false, last_seen_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION ops.register_fixed_instance(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.register_fixed_instance(text, text, text) TO dr_automation;
