/**
 * Creates and migrates a dedicated test database.
 *
 * These tests need a real Postgres: they verify row-level security policies and
 * transactional behaviour, neither of which a fake can demonstrate.
 */

import { Client } from 'pg';
import { runMigrations } from '../src/database/migrate';

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  'postgres://postgres:postgres@localhost:5433/postgres';
const TEST_DB = process.env.TEST_DATABASE_NAME ?? 'towai_test';

export function testDatabaseUrls() {
  const base = new URL(ADMIN_URL);
  base.pathname = `/${TEST_DB}`;
  const migrationUrl = base.toString();

  const app = new URL(migrationUrl);
  app.username = 'towai_app';
  app.password = 'towai_app';

  return { migrationUrl, appUrl: app.toString() };
}

export async function setup(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  try {
    // Dropped and recreated each run so tests start from a known schema.
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  const { migrationUrl } = testDatabaseUrls();
  await runMigrations(migrationUrl);
}

export async function teardown(): Promise<void> {
  // The database is left in place: when a test fails, being able to inspect the
  // rows it left behind is worth more than a clean server.
}
