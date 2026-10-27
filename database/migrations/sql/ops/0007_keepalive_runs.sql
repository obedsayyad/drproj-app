-- Supabase Free keep-alive history (docs/09). A StackStorm action runs SELECT 1 every 6 hours and
-- records the outcome here; the management API only reads it (cdr_supabase_keepalive_last_success_timestamp).
-- detail holds a short error class, never a connection string or message text.
CREATE TABLE ops.keepalive_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now(),
  succeeded   boolean NOT NULL,
  source      text NOT NULL DEFAULT 'stackstorm' CHECK (source IN ('stackstorm', 'host_cron')),
  detail      text CHECK (detail IS NULL OR length(detail) <= 200)
);
CREATE INDEX keepalive_runs_success_idx ON ops.keepalive_runs (succeeded, finished_at DESC);

-- 0002 grants only tables that existed then; grant this one explicitly. No UPDATE/DELETE: history is append-only.
GRANT SELECT, INSERT ON ops.keepalive_runs TO dr_ops;
