import { execFileSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrateToLatest } from '../../src/database/migrator';
import { createDatabase } from '../../src/shared/database/database';

declare global {
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

/**
 * Jest globalSetup: one Postgres container per test run, migrated once. Tests isolate by using
 * unique tenant ids instead of truncating (the ledger is append-only even in tests).
 * Set TEST_DATABASE_URL to reuse an existing database instead of starting a container.
 */
/**
 * Testcontainers ignores `docker context`, so OrbStack/Colima/Docker Desktop sockets are not found
 * unless DOCKER_HOST is set. Derive it from the active context when the user hasn't set it.
 */
function useActiveDockerContext(): void {
  if (process.env.DOCKER_HOST) return;
  try {
    const host = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (host && host !== 'unix:///var/run/docker.sock') process.env.DOCKER_HOST = host;
  } catch {
    // docker CLI not available: let Testcontainers use its default discovery
  }
}

export default async function globalSetup(): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    useActiveDockerContext();
    const container = await new PostgreSqlContainer('postgres:17.11-bookworm')
      .withDatabase('capacity_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    globalThis.__PG_CONTAINER__ = container;
    url = container.getConnectionUri();
  }
  process.env.DATABASE_URL = url;
  const db = createDatabase(url, { poolMax: 1 });
  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
}
