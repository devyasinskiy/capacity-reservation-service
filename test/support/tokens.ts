import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import jwt, { type SignOptions } from 'jsonwebtoken';

export const DEV_PRIVATE_KEY = readFileSync(join(__dirname, '../../dev/jwt/private.pem'), 'utf8');
export const DEV_PUBLIC_KEY = readFileSync(join(__dirname, '../../dev/jwt/public.pem'), 'utf8');
export const ROGUE_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

export interface TokenOptions {
  tenant?: string;
  scopes?: string[];
  claims?: Record<string, unknown>;
  sign?: SignOptions;
  key?: string;
}

/** Signs a token the way a real issuer would; individual tests override pieces to break it. */
export function makeToken(opts: TokenOptions = {}): string {
  return jwt.sign(
    {
      tid: opts.tenant ?? 't-1',
      scope: (opts.scopes ?? ['capacity:read']).join(' '),
      ...opts.claims,
    },
    opts.key ?? DEV_PRIVATE_KEY,
    {
      algorithm: 'RS256',
      subject: 'test-user',
      issuer: 'capacity-dev-issuer',
      audience: 'program-capacity-api',
      expiresIn: 300,
      ...opts.sign,
    },
  );
}
