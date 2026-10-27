-- Recoverable business data. This whole schema is swapped on restore (docs/09), so it
-- carries its own migration tracking and must not reference ops.

CREATE TABLE app.relief_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type text NOT NULL CHECK (resource_type IN ('food', 'water', 'medicine', 'shelter')),
  quantity      integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  location      text NOT NULL CHECK (char_length(location) BETWEEN 1 AND 500),
  urgency       text NOT NULL CHECK (urgency IN ('low', 'medium', 'high', 'critical')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'resolved')),
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relief_requests_list_idx ON app.relief_requests (created_at DESC, id DESC);

CREATE TABLE app.request_updates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES app.relief_requests (id),
  old_status text CHECK (old_status IN ('pending', 'in_progress', 'resolved')),
  new_status text NOT NULL CHECK (new_status IN ('pending', 'in_progress', 'resolved')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  source     text NOT NULL
);
CREATE INDEX request_updates_request_idx ON app.request_updates (request_id, changed_at);

CREATE TABLE app.idempotency_records (
  key             text NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{8,128}$'),
  method          text NOT NULL,
  route_template  text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (method, route_template, key)
);
CREATE INDEX idempotency_records_expires_idx ON app.idempotency_records (expires_at);

GRANT USAGE ON SCHEMA app TO dr_app_runtime, dr_backup;
GRANT SELECT, INSERT, UPDATE ON app.relief_requests TO dr_app_runtime;
GRANT SELECT, INSERT ON app.request_updates TO dr_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.idempotency_records TO dr_app_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO dr_backup;

-- docs/05: the restore role owns schema app so it can rename it during the live swap.
-- Tables stay owned by the migration user; the swapped-in tables are created (and owned) by dr_restore.
ALTER SCHEMA app OWNER TO dr_restore;
