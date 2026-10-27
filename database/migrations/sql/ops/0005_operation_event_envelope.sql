-- Operation events are published as spec/events.schema.json envelopes; event_id is the envelope id.
ALTER TABLE ops.operation_events ADD COLUMN event_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE ops.operation_events ADD CONSTRAINT operation_events_event_id_key UNIQUE (event_id);

-- Phase 2 pre-release names that are not in the schema's event_type enum.
UPDATE ops.operation_events SET event_type = 'operation.started'
  WHERE event_type IN ('operation.queued', 'operation.dispatched');
UPDATE ops.operation_events SET event_type = 'operation.waiting' WHERE event_type = 'operation.awaiting_automation';
UPDATE ops.operation_events SET event_type = 'operation.failed' WHERE event_type = 'operation.dispatch_failed';
