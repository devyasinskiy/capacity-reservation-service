/**
 * Writes http/http-client.private.env.json with DEV-ONLY tokens for the PhpStorm HTTP Client.
 *
 *   npm run http:tokens            # tokens valid for 12h
 *   npm run http:tokens -- --ttl 3600
 *
 * The HTTP Client can't sign RS256 itself, so tokens are minted here with dev/jwt/private.pem
 * (ADR-007). The output file is git-ignored; PhpStorm merges it with http-client.env.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import jwt from 'jsonwebtoken';

const { values } = parseArgs({
  options: {
    ttl: { type: 'string', default: '43200' },
    key: { type: 'string', default: 'dev/jwt/private.pem' },
    issuer: { type: 'string', default: process.env.JWT_ISSUER ?? 'capacity-dev-issuer' },
    audience: { type: 'string', default: process.env.JWT_AUDIENCE ?? 'program-capacity-api' },
  },
});

const privateKey = readFileSync(values.key, 'utf8');
const ttl = Number.parseInt(values.ttl, 10);

function mint(tenant: string, scopes: string, expiresIn = ttl): string {
  return jwt.sign({ tid: tenant, scope: scopes }, privateKey, {
    algorithm: 'RS256',
    subject: 'phpstorm-http-client',
    issuer: values.issuer,
    audience: values.audience,
    expiresIn,
  });
}

const ALL = 'capacity:read capacity:write capacity:audit';
const tokens = {
  token: mint('t-1', ALL),
  tokenReadOnly: mint('t-1', 'capacity:read'),
  tokenNoAudit: mint('t-1', 'capacity:read capacity:write'),
  tokenTenant2: mint('t-2', ALL),
  // Already expired (negative TTL), for the 401 examples.
  tokenExpired: mint('t-1', ALL, -120),
};

const out = join(__dirname, 'http-client.private.env.json');
writeFileSync(out, `${JSON.stringify({ local: tokens }, null, 2)}\n`);
process.stdout.write(`wrote ${out} (tokens valid for ${ttl}s)\n`);
