-- Records what a deploy actually left running on an existing instance (fixed primary, warm, or elastic): the image digest
-- (docker inspect RepoDigests[0]), the application version it reports, and the configuration revision. Called by the Ansible app role
-- after its readiness wait so ops.instances cannot drift from the running container. Idempotent: repeating the same facts changes only
-- last_seen_at. Every call appends an audit_events row (the application version has no column, so it is kept in the audit new_value).
CREATE FUNCTION ops.record_instance_deploy(p_instance_id uuid, p_image_digest text, p_app_version text, p_configuration_revision text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$
DECLARE
  i ops.instances%ROWTYPE;
BEGIN
  IF p_instance_id IS NULL OR p_image_digest IS NULL OR p_image_digest !~ '^sha256:[0-9a-f]{64}$'
     OR p_app_version IS NULL OR p_app_version = '' OR length(p_app_version) > 100
     OR p_configuration_revision IS NULL OR p_configuration_revision = '' OR length(p_configuration_revision) > 200 THEN
    RAISE EXCEPTION 'bad_argument' USING ERRCODE = 'CDR04';
  END IF;
  SELECT * INTO i FROM ops.instances x WHERE x.id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_instance' USING ERRCODE = 'CDR04'; END IF;
  IF i.lifecycle_state IN ('deleting', 'deleted') THEN RAISE EXCEPTION 'instance_not_live' USING ERRCODE = 'CDR03'; END IF;
  UPDATE ops.instances x SET image_digest = p_image_digest, configuration_revision = p_configuration_revision, last_seen_at = now() WHERE x.id = p_instance_id;
  INSERT INTO ops.audit_events (source, action, object, old_value, new_value)
  VALUES ('automation', 'instance.deploy_recorded', 'instance:' || p_instance_id::text,
          jsonb_build_object('image_digest', i.image_digest, 'configuration_revision', i.configuration_revision),
          jsonb_build_object('image_digest', p_image_digest, 'configuration_revision', p_configuration_revision, 'app_version', p_app_version));
END $$;

REVOKE ALL ON FUNCTION ops.record_instance_deploy(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.record_instance_deploy(uuid, text, text, text) TO dr_automation;
