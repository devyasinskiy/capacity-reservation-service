import { DomainError } from '../errors/domain-error';

/**
 * Explicit ISO 4217 whitelist with minor-unit exponents (ADR-002). KWD (3) and JPY (0) are
 * included deliberately to exercise exponent handling in both directions.
 */
const EXPONENTS = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CHF: 2,
  JPY: 0,
  KWD: 3,
} as const satisfies Record<string, number>;

/** ISO 4217 codes this service accepts. */
export type CurrencyCode = keyof typeof EXPONENTS;

/** A supported currency and its minor-unit exponent (USD = 2, JPY = 0, KWD = 3). */
export interface Currency {
  readonly code: CurrencyCode;
  readonly exponent: number;
}

/** All supported currency codes, e.g. for validation messages and OpenAPI enums. */
export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = Object.keys(
  EXPONENTS,
) as CurrencyCode[];

/** Type guard: is `code` on the supported whitelist? */
export function isSupportedCurrency(code: string): code is CurrencyCode {
  return Object.hasOwn(EXPONENTS, code);
}

/**
 * Resolves a code to its currency definition.
 * @throws DomainError `CURRENCY_NOT_SUPPORTED` if the code is not whitelisted.
 */
export function currency(code: string): Currency {
  if (!isSupportedCurrency(code)) {
    throw new DomainError('CURRENCY_NOT_SUPPORTED', `Currency ${code} is not supported`, {
      currency: code,
    });
  }
  return { code, exponent: EXPONENTS[code] };
}
