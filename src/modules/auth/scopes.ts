/** OAuth2-style scopes carried in the space-separated `scope` claim (ADR-007). */
export const Scope = {
  READ: 'capacity:read',
  WRITE: 'capacity:write',
  AUDIT: 'capacity:audit',
} as const;

/** A scope value from {@link Scope}. */
export type Scope = (typeof Scope)[keyof typeof Scope];
