-- Management/control records. Lives outside schema app so app restores never touch it.
-- Enums are text + CHECK (docs/05 canonical vocabulary). No foreign keys into app.

CREATE TABLE ops.policy_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version          integer NOT NULL UNIQUE CHECK (version >= 1),
  configuration    jsonb NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'active', 'failed', 'superseded')),
  activation_phase text CHECK (activation_phase IN ('validating', 'compiling', 'applying', 'verifying', 'completed')),
  apply_result     jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  activated_at     timestamptz
);
CREATE UNIQUE INDEX policy_versions_one_active ON ops.policy_versions ((true)) WHERE status = 'active';

CREATE TABLE ops.capacity_slots (
  key                text PRIMARY KEY CHECK (
    key = 'warm'
    OR key ~ '^elastic-do-[1-5]$'
    OR key ~ '^elastic-linode-[1-5]$'
    OR key IN ('interim-warm-digitalocean', 'interim-warm-linode')
  ),
  provider           text NOT NULL CHECK (provider IN ('digitalocean', 'linode')),
  role               text NOT NULL CHECK (role IN ('warm', 'elastic')),
  generation         bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  state              text NOT NULL DEFAULT 'free' CHECK (state IN ('free', 'reserved', 'bound', 'releasing', 'held_uncertain')),
  bound_instance_id  uuid,
  lease_operation_id uuid,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops.instances (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_key                text REFERENCES ops.capacity_slots (key),
  provider                text NOT NULL CHECK (provider IN ('self_hosted', 'digitalocean', 'linode')),
  provider_resource_id    text,
  role                    text NOT NULL CHECK (role IN ('primary', 'warm', 'elastic')),
  public_ip               text,
  vcpu                    integer CHECK (vcpu >= 1),
  memory_mb               integer CHECK (memory_mb >= 1),
  image_digest            text,
  configuration_revision  text,
  lifecycle_state         text NOT NULL CHECK (lifecycle_state IN ('reserved', 'provisioning', 'deploying', 'ready', 'draining', 'deleting', 'deleted', 'failed', 'unknown')),
  health_state            text,
  routing_mode            text NOT NULL DEFAULT 'none' CHECK (routing_mode IN ('none', 'backup', 'active', 'draining')),
  routing_weight          integer NOT NULL DEFAULT 0 CHECK (routing_weight BETWEEN 0 AND 256),
  slot_state              text CHECK (slot_state IN ('free', 'reserved', 'bound', 'releasing', 'held_uncertain')),
  last_seen_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instances_active_requires_ready CHECK (routing_mode <> 'active' OR lifecycle_state = 'ready'),
  CONSTRAINT instances_cloud_has_slot CHECK (provider = 'self_hosted' OR slot_key IS NOT NULL),
  UNIQUE (provider, provider_resource_id)
);
CREATE INDEX instances_slot_key_idx ON ops.instances (slot_key);

ALTER TABLE ops.capacity_slots
  ADD CONSTRAINT capacity_slots_bound_instance_fk
  FOREIGN KEY (bound_instance_id) REFERENCES ops.instances (id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE ops.operations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    text NOT NULL CHECK (kind IN ('activate_standby', 'scale_out', 'scale_in', 'primary_failure', 'failback', 'provision_and_deploy', 'standby_repair', 'reconcile', 'apply_policy', 'create_backup', 'verify_backup', 'restore_application', 'start_load_test', 'stop_load_test')),
  idempotency_key         text UNIQUE,
  request_hash            text,
  policy_version          integer NOT NULL CHECK (policy_version >= 1),
  automation_revision     text,
  image_digest            text,
  stackstorm_execution_id text,
  status                  text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting', 'verifying', 'paused', 'reconciling', 'cancelling', 'cancelled', 'succeeded', 'failed')),
  current_step            text,
  outcome                 jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  finished_at             timestamptz
);
CREATE INDEX operations_status_idx ON ops.operations (status, created_at DESC);

CREATE TABLE ops.operation_attempts (
  operation_id      uuid NOT NULL REFERENCES ops.operations (id),
  attempt           integer NOT NULL CHECK (attempt >= 1),
  provider          text CHECK (provider IN ('self_hosted', 'digitalocean', 'linode')),
  stackstorm_action_id text,
  checkpoint_at     timestamptz,
  deadline_at       timestamptz,
  error_code        text,
  result_refs       jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, attempt)
);

CREATE TABLE ops.incidents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint        text NOT NULL CHECK (char_length(fingerprint) <= 256),
  severity           text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  state              text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  source             text,
  description        text,
  affected_resources text[] NOT NULL DEFAULT '{}',
  opened_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz
);
CREATE UNIQUE INDEX incidents_one_open_per_fingerprint ON ops.incidents (fingerprint) WHERE state = 'open';

CREATE TABLE ops.incident_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid NOT NULL REFERENCES ops.incidents (id),
  event_kind   text NOT NULL,
  message      text,
  source       text,
  operation_id uuid REFERENCES ops.operations (id),
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops.backups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_path       text,
  source_identifier   text,
  capture_started_at  timestamptz NOT NULL DEFAULT now(),
  capture_finished_at timestamptz,
  schema_revision     text,
  bytes               bigint CHECK (bytes >= 0),
  checksum            text,
  capture_status      text NOT NULL DEFAULT 'capturing' CHECK (capture_status IN ('capturing', 'captured', 'failed')),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'verifying', 'verified', 'failed')),
  error_code          text,
  error_message       text,
  verified_at         timestamptz,
  expired_at          timestamptz,
  is_safety_backup    boolean NOT NULL DEFAULT false,
  CONSTRAINT backups_verified_requires_captured CHECK (verification_status <> 'verified' OR capture_status = 'captured')
);

CREATE TABLE ops.recovery_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id           uuid NOT NULL REFERENCES ops.backups (id),
  safety_backup_id    uuid REFERENCES ops.backups (id),
  isolated_target     text,
  validation_results  jsonb,
  maintenance_state   text,
  restore_result      text,
  rollback_result     text,
  operation_id        uuid REFERENCES ops.operations (id),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);

CREATE TABLE ops.audit_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL CHECK (source IN ('dashboard', 'automation', 'reconciliation', 'alertmanager', 'timer')),
  actor        text CHECK (actor = 'operator'),
  action       text NOT NULL,
  object       text,
  old_value    jsonb,
  new_value    jsonb,
  operation_id uuid,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops.control_leases (
  application_key    text PRIMARY KEY,
  holder_operation   uuid,
  lease_expires_at   timestamptz,
  fencing_generation bigint NOT NULL DEFAULT 0 CHECK (fencing_generation >= 0)
);

-- Singleton. Survives app restores; app runtime reads it only via ops.app_maintenance_state().
CREATE TABLE ops.runtime_flags (
  singleton         boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  maintenance       boolean NOT NULL DEFAULT false,
  incident_id       uuid,
  generation        bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  last_changed_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ops.runtime_flags (singleton) VALUES (true);

CREATE TABLE ops.test_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id     uuid REFERENCES ops.operations (id),
  scenario         text NOT NULL CHECK (scenario IN ('smoke', 'baseline', 'compute_pressure', 'sustained_surge', 'recovery')),
  rate_rps         integer NOT NULL CHECK (rate_rps BETWEEN 1 AND 200),
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 600),
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting', 'verifying', 'paused', 'reconciling', 'cancelling', 'cancelled', 'succeeded', 'failed')),
  results_location text,
  summary          jsonb,
  started_at       timestamptz,
  finished_at      timestamptz
);

CREATE TABLE ops.processed_events (
  fingerprint     text NOT NULL,
  policy_version  integer NOT NULL CHECK (policy_version >= 1),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  operation_id    uuid REFERENCES ops.operations (id),
  PRIMARY KEY (fingerprint, policy_version)
);

-- The only ops object the app runtime may touch: fail-closed callers treat an error as "unreadable".
CREATE FUNCTION ops.app_maintenance_state()
RETURNS TABLE (maintenance boolean, generation bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops
AS $$ SELECT f.maintenance, f.generation FROM ops.runtime_flags f WHERE f.singleton $$;

REVOKE ALL ON FUNCTION ops.app_maintenance_state() FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO dr_app_runtime;
GRANT EXECUTE ON FUNCTION ops.app_maintenance_state() TO dr_app_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ops TO dr_ops;
