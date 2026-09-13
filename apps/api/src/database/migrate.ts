/**
 * Migration runner.
 *
 * Applies `migrations/*.sql` in filename order, once each, inside a transaction,
 * tracking what has run in `schema_migrations`.
 *
 * Hand-written SQL rather than generated migrations: the row-level security
 * policies and the application role are as much a part of the schema as the
 * tables, and they need to be created in the same transaction as the tables
 * they protect. A generator that only knows about columns would leave a window
 * where the tables exist without their policies.
 *
 * Runs as the *owner* role (DATABASE_MIGRATION_URL), which is deliberately not
 * the role the application uses — owners bypass RLS.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations(connectionString: string): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    );
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`applying ${file} ... `);

      // Each migration file manages its own BEGIN/COMMIT so it can contain
      // statements that must not share a transaction with anything else.
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        applied.push(file);
        process.stdout.write('ok\n');
      } catch (error) {
        process.stdout.write('FAILED\n');
        throw error;
      }
    }

    if (applied.length === 0) process.stdout.write('no pending migrations\n');
    return applied;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  require('./load-env');
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'Set DATABASE_MIGRATION_URL (or DATABASE_URL) to the owner connection string.',
    );
    process.exit(1);
  }

  runMigrations(url).then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
