import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Track = 'ops' | 'app';
/** ops first: it creates the roles that the app track grants to. */
export const TRACKS: readonly Track[] = ['ops', 'app'];

export interface MigrationFile {
  track: Track;
  name: string;
  sql: string;
  checksum: string;
}

const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export const checksumOf = (sql: string): string => createHash('sha256').update(sql).digest('hex');

export async function discoverMigrations(sqlDir: string, track: Track): Promise<MigrationFile[]> {
  const dir = join(sqlDir, track);
  const names = (await readdir(dir)).filter((n) => FILE_PATTERN.test(n)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(dir, name), 'utf8');
      return { track, name, sql, checksum: checksumOf(sql) };
    }),
  );
}

export interface MigrationPlan {
  pending: MigrationFile[];
  /** Applied files whose content changed since they were applied. */
  changed: string[];
  /** Applied names no longer present on disk. */
  missing: string[];
}

export function planMigrations(files: readonly MigrationFile[], applied: ReadonlyMap<string, string>): MigrationPlan {
  const onDisk = new Set(files.map((f) => f.name));
  const changed = files.filter((f) => applied.has(f.name) && applied.get(f.name) !== f.checksum).map((f) => f.name);
  const missing = [...applied.keys()].filter((n) => !onDisk.has(n)).sort();
  return { pending: files.filter((f) => !applied.has(f.name)), changed, missing };
}
