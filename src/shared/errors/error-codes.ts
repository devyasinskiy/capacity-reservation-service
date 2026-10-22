/** Stable, client-facing error codes (ADR-015). Adding a code is a public API change. */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INSUFFICIENT_SCOPE: 'INSUFFICIENT_SCOPE',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/** Union of the non-domain error codes in {@link ErrorCode}. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
