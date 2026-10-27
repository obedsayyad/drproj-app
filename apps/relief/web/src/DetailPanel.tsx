import { useEffect, useState } from 'react';
import { ApiError, newKey, updateStatus, type ReliefRequest, type ReliefRequestDetail, type RequestStatus } from './api';
import { ACTIONS, resourceLabel, statusLabel, urgencyLabel, when } from './labels';

export function DetailPanel(props: {
  id: string;
  fetchDetail: (id: string) => Promise<ReliefRequestDetail>;
  onClose: () => void;
  onUpdated: (r: ReliefRequest) => void;
  onWriteResult: (e: ApiError | null) => void;
}) {
  const [detail, setDetail] = useState<ReliefRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { id, fetchDetail } = props;

  const reload = async () => {
    try {
      setDetail(await fetchDetail(id));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'This request no longer exists.' : 'Could not load this request.');
    }
  };
  useEffect(() => void reload(), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (to: RequestStatus) => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateStatus(detail.id, to, detail.version, newKey());
      props.onWriteResult(null);
      props.onUpdated(updated);
      await reload();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      props.onWriteResult(err);
      if (err?.code === 'VERSION_CONFLICT') {
        setError('Someone else changed this request. The latest version is shown below.');
        await reload();
      } else if (err?.code === 'MAINTENANCE_WRITES_BLOCKED') {
        setError('Maintenance is in progress, so status changes are paused.');
      } else {
        setError(err?.message ?? 'Could not change the status.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel detail" aria-labelledby="detail-title">
      <button className="quiet back" onClick={props.onClose}>
        Log a new request
      </button>
      {!detail ? (
        <p className={error ? 'inline-error' : 'empty'}>{error ?? 'Loading…'}</p>
      ) : (
        <>
          <h2 id="detail-title" className={`detail-need urgency-${detail.urgency}`}>
            {detail.quantity.toLocaleString('en-IN')} {resourceLabel(detail.resource_type).toLowerCase()}
          </h2>
          <p className="detail-where">{detail.location}</p>
          <dl className="facts">
            <div>
              <dt>Urgency</dt>
              <dd>{urgencyLabel(detail.urgency)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd className={`status status-${detail.status}`}>{statusLabel(detail.status)}</dd>
            </div>
            <div>
              <dt>Logged</dt>
              <dd>{when(detail.created_at)}</dd>
            </div>
          </dl>
          <div className="actions">
            {ACTIONS[detail.status].map((a, i) => (
              <button key={a.to} className={i === 0 ? 'primary' : 'secondary'} disabled={busy} onClick={() => void act(a.to)}>
                {a.label}
              </button>
            ))}
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <h3>History</h3>
          <ol className="history">
            {[...detail.history].reverse().map((h) => (
              <li key={h.id}>
                <span>{h.old_status ? `${statusLabel(h.old_status)} to ${statusLabel(h.new_status)}` : 'Logged'}</span>
                <time dateTime={h.changed_at}>{when(h.changed_at)}</time>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
