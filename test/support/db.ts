import { randomUUID } from 'node:crypto';
import { createDatabase, type DatabaseOptions } from '../../src/shared/database/database';

export function testDatabase(options: DatabaseOptions = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set — is the Jest globalSetup configured?');
  return createDatabase(url, { poolMax: 10, ...options });
}

/** Unique tenant per test so suites never interfere and nothing needs truncating. */
export const uniqueTenant = () => `t-${randomUUID().slice(0, 8)}`;
