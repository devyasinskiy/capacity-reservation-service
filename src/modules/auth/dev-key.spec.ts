import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertVerificationKeyAllowed,
  DEV_PUBLIC_KEY_FINGERPRINT,
  publicKeyFingerprint,
} from './dev-key';

const devPem = readFileSync(join(__dirname, '../../../dev/jwt/public.pem'), 'utf8');
const otherPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();

describe('dev key guard', () => {
  it('pins the fingerprint of the committed dev key', () => {
    expect(publicKeyFingerprint(devPem)).toBe(DEV_PUBLIC_KEY_FINGERPRINT);
  });

  it('refuses the dev key in production', () => {
    expect(() => assertVerificationKeyAllowed(devPem, 'production')).toThrow(/DEV-ONLY/);
  });

  it('allows the dev key outside production and other keys in production', () => {
    expect(() => assertVerificationKeyAllowed(devPem, 'development')).not.toThrow();
    expect(() => assertVerificationKeyAllowed(otherPem, 'production')).not.toThrow();
  });
});
