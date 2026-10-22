import { z } from 'zod';

/** The authenticated caller. Tenant comes only from the verified token, never from the request. */
export interface Principal {
  readonly subject: string;
  readonly tenantId: string;
  readonly scopes: ReadonlySet<string>;
}

// Signature, alg, iss, aud and exp are verified by passport-jwt before this runs; this schema
// enforces the claims *we* depend on (ADR-007, ADR-017).
const claimsSchema = z.object({
  sub: z.string().min(1).max(256),
  tid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  scope: z.string().max(1024).optional(),
  exp: z.number().int(),
});

/**
 * Builds a {@link Principal} from verified JWT claims.
 * @returns null if the claims we depend on are missing or malformed.
 */
export function principalFromClaims(payload: unknown): Principal | null {
  const parsed = claimsSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { sub, tid, scope } = parsed.data;
  return {
    subject: sub,
    tenantId: tid,
    scopes: new Set((scope ?? '').split(' ').filter((s) => s.length > 0)),
  };
}
