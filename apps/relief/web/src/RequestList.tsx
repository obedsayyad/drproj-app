import type { ReliefRequest } from './api';
import { ago, resourceLabel, statusLabel, urgencyLabel } from './labels';

export function RequestList(props: {
  items: ReliefRequest[];
  loading: boolean;
  error: string | null;
  selected: string | null;
  onSelect: (id: string) => void;
  hasMore: boolean;
  onMore: () => void;
  filtered: boolean;
}) {
  const { items, loading, error } = props;
  if (error && items.length === 0) {
    return <p className="empty error">{error}</p>;
  }
  if (!loading && items.length === 0) {
    return (
      <p className="empty">
        {props.filtered ? 'No requests match these filters. Clear a filter to see more.' : 'No requests yet. Log the first one with the form.'}
      </p>
    );
  }
  return (
    <>
      <ul className="rows" aria-busy={loading}>
        {items.map((r) => (
          <li key={r.id}>
            <button
              className={`row urgency-${r.urgency} ${props.selected === r.id ? 'is-selected' : ''}`}
              onClick={() => props.onSelect(r.id)}
              aria-current={props.selected === r.id}
            >
              <span className="row-need">
                <span className="qty">{r.quantity.toLocaleString('en-IN')}</span> {resourceLabel(r.resource_type).toLowerCase()}
              </span>
              <span className="row-where">{r.location}</span>
              <span className="row-meta">
                <span className="urgency-tag">{urgencyLabel(r.urgency)}</span>
                <span className={`status status-${r.status}`}>{statusLabel(r.status)}</span>
                <time dateTime={r.created_at}>{ago(r.created_at)}</time>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="inline-error">{error}</p>}
      {props.hasMore && (
        <button className="more" onClick={props.onMore} disabled={loading}>
          {loading ? 'Loading…' : 'Show older requests'}
        </button>
      )}
    </>
  );
}
