import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getRequest,
  listRequests,
  onInstance,
  ping,
  type Filters,
  type Instance,
  type ReliefRequest,
} from './api';
import { DetailPanel } from './DetailPanel';
import { NewRequestForm } from './NewRequestForm';
import { RequestList } from './RequestList';
import { describeInstance, RESOURCES, STATUSES, URGENCIES } from './labels';

export function App() {
  const [filters, setFilters] = useState<Filters>({});
  const [items, setItems] = useState<ReliefRequest[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState(false);
  const instance = useServedBy();

  const load = useCallback(async (f: Filters) => {
    setLoading(true);
    setListError(null);
    try {
      const page = await listRequests(f);
      setItems(page.items);
      setCursor(page.next_cursor);
    } catch (e) {
      setListError(e instanceof ApiError ? e.message : 'Could not load requests.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(filters), [filters, load]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await listRequests(filters, cursor);
      setItems((prev) => [...prev, ...page.items.filter((i) => !prev.some((p) => p.id === i.id))]);
      setCursor(page.next_cursor);
    } catch (e) {
      setListError(e instanceof ApiError ? e.message : 'Could not load more requests.');
    } finally {
      setLoading(false);
    }
  };

  /** Writes report maintenance; any later successful write clears the banner. */
  const onWriteResult = (err: ApiError | null) => {
    if (!err) setMaintenance(false);
    else if (err.code === 'MAINTENANCE_WRITES_BLOCKED' || err.code === 'DEPENDENCY_UNAVAILABLE') setMaintenance(true);
  };

  const upsert = (r: ReliefRequest) =>
    setItems((prev) => (prev.some((p) => p.id === r.id) ? prev.map((p) => (p.id === r.id ? r : p)) : [r, ...prev]));

  const setFilter = (key: keyof Filters, value: string) =>
    setFilters((f) => {
      const next = { ...f };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <h1>Relief requests</h1>
          <p>Log what a site needs and track it until it arrives.</p>
        </div>
        <ServedBy instance={instance} />
      </header>

      {maintenance && (
        <div className="notice" role="status">
          <strong>Maintenance in progress.</strong> You can still browse requests. New requests and status changes are
          paused; try again in about a minute.
        </div>
      )}

      <main className="board">
        <section className="queue" aria-labelledby="queue-title">
          <div className="queue-head">
            <h2 id="queue-title">Queue</h2>
            <button className="quiet" onClick={() => void load(filters)} disabled={loading}>
              Refresh
            </button>
          </div>
          <div className="filters">
            <Select label="Need" value={filters.resource_type} options={RESOURCES} onChange={(v) => setFilter('resource_type', v)} />
            <Select label="Urgency" value={filters.urgency} options={URGENCIES} onChange={(v) => setFilter('urgency', v)} />
            <Select label="Status" value={filters.status} options={STATUSES} onChange={(v) => setFilter('status', v)} />
          </div>
          <RequestList
            items={items}
            loading={loading}
            error={listError}
            selected={selected}
            onSelect={setSelected}
            hasMore={Boolean(cursor)}
            onMore={() => void loadMore()}
            filtered={Object.keys(filters).length > 0}
          />
        </section>

        <aside className="side">
          {selected ? (
            <DetailPanel
              key={selected}
              id={selected}
              fetchDetail={getRequest}
              onClose={() => setSelected(null)}
              onUpdated={upsert}
              onWriteResult={onWriteResult}
            />
          ) : (
            <NewRequestForm
              onCreated={(r) => {
                upsert(r);
                setSelected(r.id);
              }}
              onWriteResult={onWriteResult}
            />
          )}
        </aside>
      </main>
    </div>
  );
}

function Select(props: {
  label: string;
  value: string | undefined;
  options: readonly (readonly [string, string])[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="select">
      <span>{props.label}</span>
      <select value={props.value ?? ''} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">All</option>
        {props.options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Tracks which server answered last; pings liveness so failover is visible without clicking. */
function useServedBy(): Instance | null {
  const [id, setId] = useState<Instance | null>(null);
  useEffect(() => {
    const off = onInstance(setId);
    const tick = () => void ping().catch(() => undefined);
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  return id;
}

function ServedBy({ instance }: { instance: Instance | null }) {
  const [flash, setFlash] = useState(false);
  const prev = useRef<string | null>(null);
  const id = instance?.id ?? null;
  useEffect(() => {
    if (prev.current && id && prev.current !== id) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1200);
      prev.current = id;
      return () => clearTimeout(t);
    }
    prev.current = id;
  }, [id]);
  return (
    <div className={`served ${flash ? 'served-changed' : ''}`} aria-live="polite">
      <span className="served-label">Answered by:</span>
      <span className="served-id" title={instance ? `Instance ${instance.id}` : undefined}>
        {instance ? describeInstance(instance) : 'connecting…'}
      </span>
    </div>
  );
}
