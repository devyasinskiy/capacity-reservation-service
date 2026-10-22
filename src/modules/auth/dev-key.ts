import { createHash, createPublicKey } from 'node:crypto';

/** SHA-256 of the SPKI DER of the committed dev key in `dev/jwt/public.pem` (ADR-007). */
export const DEV_PUBLIC_KEY_FINGERPRINT =
  '3477a6826d771515748a6a64095c60a73161000dd6982e716d134a584daf4e4b';

/** SHA-256 (hex) of a PEM public key's SPKI DER encoding; stable across PEM formatting. */
export function publicKeyFingerprint(pem: string): string {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/** Fail fast: the committed dev key must never verify tokens in production. */
export function assertVerificationKeyAllowed(pem: string, nodeEnv: string): void {
  if (nodeEnv === 'production' && publicKeyFingerprint(pem) === DEV_PUBLIC_KEY_FINGERPRINT) {
    throw new Error('Refusing to start: the DEV-ONLY JWT key is configured in production.');
  }
}
