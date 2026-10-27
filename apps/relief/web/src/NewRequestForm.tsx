import { useRef, useState, type FormEvent } from 'react';
import { ApiError, createRequest, newKey, type ReliefRequest, type ReliefRequestInput } from './api';
import { RESOURCES, URGENCIES } from './labels';

type Draft = { resource_type: string; quantity: string; location: string; urgency: string };
const EMPTY: Draft = { resource_type: 'water', quantity: '', location: '', urgency: 'high' };

export function NewRequestForm(props: { onCreated: (r: ReliefRequest) => void; onWriteResult: (e: ApiError | null) => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per logical submission: retries after a timeout reuse it, so nothing is logged twice.
  const key = useRef<string | null>(null);

  const change = (patch: Partial<Draft>) => {
    key.current = null;
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const quantity = Number(draft.quantity);
  const valid = Number.isInteger(quantity) && quantity >= 1 && quantity <= 10000 && draft.location.trim().length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    key.current ??= newKey();
    setBusy(true);
    setError(null);
    try {
      const input = { ...draft, quantity, location: draft.location.trim() } as ReliefRequestInput;
      const created = await createRequest(input, key.current);
      props.onWriteResult(null);
      key.current = null;
      setDraft(EMPTY);
      props.onCreated(created);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      props.onWriteResult(apiErr);
      setError(messageFor(apiErr));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={(e) => void submit(e)} noValidate>
      <h2>Log a request</h2>
      <fieldset className="choice">
        <legend>What is needed</legend>
        {RESOURCES.map(([v, l]) => (
          <label key={v} className={draft.resource_type === v ? 'on' : ''}>
            <input type="radio" name="resource" value={v} checked={draft.resource_type === v} onChange={() => change({ resource_type: v })} />
            {l}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>How many</span>
        <input
          inputMode="numeric"
          value={draft.quantity}
          onChange={(e) => change({ quantity: e.target.value.replace(/\D/g, '') })}
          placeholder="Up to 10,000"
          aria-describedby="qty-hint"
        />
        <small id="qty-hint">Units, litres, kits or beds, whichever fits the need.</small>
      </label>
      <label className="field">
        <span>Where</span>
        <input value={draft.location} maxLength={500} onChange={(e) => change({ location: e.target.value })} placeholder="Camp, building or landmark" />
      </label>
      <fieldset className="choice urgency-choice">
        <legend>Urgency</legend>
        {URGENCIES.map(([v, l]) => (
          <label key={v} className={`urgency-${v} ${draft.urgency === v ? 'on' : ''}`}>
            <input type="radio" name="urgency" value={v} checked={draft.urgency === v} onChange={() => change({ urgency: v })} />
            {l}
          </label>
        ))}
      </fieldset>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" type="submit" disabled={!valid || busy}>
        {busy ? 'Logging…' : error && key.current ? 'Try again' : 'Log request'}
      </button>
    </form>
  );
}

function messageFor(e: ApiError | null): string {
  if (!e) return 'Something went wrong. Try again.';
  switch (e.code) {
    case 'MAINTENANCE_WRITES_BLOCKED':
      return 'Maintenance is in progress, so new requests are paused. Try again in about a minute.';
    case 'DEPENDENCY_UNAVAILABLE':
      return 'The database is not reachable right now. Your request was not logged; try again shortly.';
    case 'IDEMPOTENCY_IN_FLIGHT':
      return 'Your earlier attempt is still being saved. Try again in a couple of seconds.';
    case 'RATE_LIMITED':
      return `Too many requests from this device. Wait ${e.retryAfter ?? 10} seconds and try again.`;
    default:
      return e.message;
  }
}
