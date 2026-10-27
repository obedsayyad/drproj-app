import { runMigrations } from './migrate.js';

const flag = process.argv.indexOf('--database-url-env');
const envName = flag >= 0 ? process.argv[flag + 1] : 'SUPABASE_MIGRATION_URL';
const url = envName ? process.env[envName] : undefined;

if (!envName || !url) {
  console.error(`Set ${envName ?? 'the variable named by --database-url-env'} to a session-pooler connection string.`);
  process.exit(2);
}

try {
  const { applied } = await runMigrations({ connectionString: url });
  console.log(applied.length === 0 ? 'No pending migrations.' : `Applied:\n${applied.map((a) => `  ${a}`).join('\n')}`);
} catch (err) {
  // Message only: never print the connection string.
  console.error(err instanceof Error ? err.message : 'migration failed');
  process.exit(1);
}
