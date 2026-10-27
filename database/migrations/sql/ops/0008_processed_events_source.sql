-- processed_events coalesces repeated external notifications (docs/05). P3.2 records Alertmanager alerts
-- only; the source column keeps later sources (automation, timer, ...) distinguishable, and event_name
-- holds the alertname for dashboard display. Nothing is acted on from this table before P4.
ALTER TABLE ops.processed_events
  ADD COLUMN source     text NOT NULL DEFAULT 'alertmanager'
    CHECK (source IN ('dashboard', 'automation', 'reconciliation', 'alertmanager', 'timer')),
  ADD COLUMN event_name text CHECK (event_name IS NULL OR length(event_name) <= 100);
