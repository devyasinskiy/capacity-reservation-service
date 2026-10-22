/**
 * Mints a DEV-ONLY RS256 access token signed with dev/jwt/private.pem (ADR-007).
 *
 *   npm run token -- --tenant t-1 --scopes "capacity:read capacity:write" --ttl 3600
 *
 * Prints only the token to stdout, so it composes: TOKEN=$(npm run -s token -- --tenant t-1)
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import jwt from 'jsonwebtoken';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string', default: 't-1' },
    sub: { type: 'string', default: 'dev-user' },
    scopes: { type: 'string', default: 'capacity:read capacity:write capacity:audit' },
    ttl: { type: 'string', default: '3600' },
    key: { type: 'string', default: 'dev/jwt/private.pem' },
    issuer: { type: 'string', default: process.env.JWT_ISSUER ?? 'capacity-dev-issuer' },
    audience: { type: 'string', default: process.env.JWT_AUDIENCE ?? 'program-capacity-api' },
  },
});

const token = jwt.sign(
  { tid: values.tenant, scope: values.scopes },
  readFileSync(values.key, 'utf8'),
  {
    algorithm: 'RS256',
    subject: values.sub,
    issuer: values.issuer,
    audience: values.audience,
    expiresIn: Number.parseInt(values.ttl, 10),
  },
);

process.stdout.write(`${token}\n`);
