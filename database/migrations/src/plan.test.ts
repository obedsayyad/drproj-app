import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checksumOf, discoverMigrations, planMigrations, type MigrationFile } from './plan.js';

const file = (name: string, sql: string): MigrationFile => ({ track: 'app', name, sql, checksum: checksumOf(sql) });

describe('planMigrations', () => {
  it('returns only unapplied files, in order', () => {
    const files = [file('0001_a.sql', 'a'), file('0002_b.sql', 'b')];
    const plan = planMigrations(files, new Map([['0001_a.sql', checksumOf('a')]]));
    expect(plan.pending.map((f) => f.name)).toEqual(['0002_b.sql']);
    expect(plan.changed).toEqual([]);
  });

  it('flags an applied file whose content changed', () => {
    const plan = planMigrations([file('0001_a.sql', 'a2')], new Map([['0001_a.sql', checksumOf('a')]]));
    expect(plan.changed).toEqual(['0001_a.sql']);
  });

  it('flags applied migrations missing from disk', () => {
    const plan = planMigrations([], new Map([['0001_a.sql', 'x']]));
    expect(plan.missing).toEqual(['0001_a.sql']);
  });
});

describe('discoverMigrations', () => {
  it('sorts numerically-prefixed files and ignores others', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mig-'));
    await mkdir(join(root, 'app'));
    for (const n of ['0002_b.sql', '0001_a.sql', 'notes.txt', '3_bad.sql']) await writeFile(join(root, 'app', n), n);
    const found = await discoverMigrations(root, 'app');
    expect(found.map((f) => f.name)).toEqual(['0001_a.sql', '0002_b.sql']);
  });
});
