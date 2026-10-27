// Deterministic demo data (Phase 1). Idempotent: fixed IDs, ON CONFLICT DO NOTHING.
// Uses the app runtime connection and honors maintenance like every other write.
import { createPool } from '../src/db.js';
import { inTransaction } from '../src/db.js';
import { assertWritable } from '../src/maintenance.js';
import { UPDATE_SOURCE } from '../src/requests.js';

const url = process.env['SUPABASE_APP_URL'];
if (!url) {
  console.error('SUPABASE_APP_URL is not set');
  process.exit(1);
}

type Row = [resource: string, quantity: number, location: string, urgency: string];
const ROWS: Row[] = [
  ['water', 500, 'Kothrud relief camp, Pune', 'critical'],
  ['food', 1200, 'Hadapsar community hall, Pune', 'high'],
  ['medicine', 80, 'Sassoon General Hospital, Pune', 'critical'],
  ['shelter', 40, 'Yerawada school grounds, Pune', 'high'],
  ['water', 250, 'Baner ward office, Pune', 'medium'],
  ['food', 300, 'Shivajinagar bus depot, Pune', 'medium'],
  ['medicine', 25, 'Aundh primary health centre, Pune', 'high'],
  ['shelter', 15, 'Wakad sports complex, Pune', 'low'],
  ['water', 900, 'Pimpri station camp, Pune', 'critical'],
  ['food', 60, 'Katraj temple trust hall, Pune', 'low'],
  ['medicine', 150, 'Viman Nagar clinic, Pune', 'medium'],
  ['shelter', 120, 'Hinjewadi phase 1 hall, Pune', 'high'],
];
const BASE = Date.UTC(2026, 9, 1, 6, 0, 0);

const pool = createPool(url, 1);
try {
  const inserted = await inTransaction(pool, async (c) => {
    await assertWritable(c, 60);
    let n = 0;
    for (const [i, [resource, quantity, location, urgency]] of ROWS.entries()) {
      const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      const at = new Date(BASE + i * 15 * 60_000).toISOString();
      const r = await c.query(
        `INSERT INTO app.relief_requests (id, resource_type, quantity, location, urgency, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT (id) DO NOTHING`,
        [id, resource, quantity, location, urgency, at],
      );
      if (r.rowCount === 1) {
        n++;
        await c.query(
          `INSERT INTO app.request_updates (request_id, old_status, new_status, changed_at, source)
           VALUES ($1, NULL, 'pending', $2, $3)`,
          [id, at, `${UPDATE_SOURCE}:seed`],
        );
      }
    }
    return n;
  });
  console.log(JSON.stringify({ msg: 'seed complete', inserted, total: ROWS.length }));
} catch (err) {
  console.error(JSON.stringify({ msg: 'seed failed', error: (err as Error).message }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
