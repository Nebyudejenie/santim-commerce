/**
 * Money — integer minor units only.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `0.1 + 0.2 === 0.30000000000000004`. Floating point cannot represent decimal
 * fractions exactly, so any system that stores money as a float will, given
 * enough transactions, produce totals that do not reconcile with the bank.
 * The fix is universal and non-negotiable: store money as an integer count of
 * the smallest indivisible unit, and convert to a decimal only at the edges
 * (display, and third-party APIs that demand it).
 *
 * ETB has 100 santim to 1 birr.
 */

/** Branded integer: a count of santim (1/100 ETB). */
export type Santim = number & { readonly __brand: unique symbol };

export class MoneyError extends Error {
  override name = "MoneyError";
}

/** Construct from a whole number of santim. */
export function santim(value: number): Santim {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`santim must be an integer, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`santim out of safe integer range: ${value}`);
  }
  return value as Santim;
}

/**
 * Construct from birr. Accepts at most 2 decimal places and rejects anything
 * finer — silently rounding a customer's money is how you lose an audit.
 */
export function birr(value: number): Santim {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`birr must be finite, received ${value}`);
  }
  const scaled = value * 100;
  // Guard against binary representation error before the integer check:
  // 19.99 * 100 === 1998.9999999999998 in IEEE-754.
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new MoneyError(
      `birr supports at most 2 decimal places, received ${value}`,
    );
  }
  return santim(rounded);
}

/** Parse a decimal string such as "1234.50" without ever touching a float. */
export function parseBirr(input: string): Santim {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) {
    throw new MoneyError(`cannot parse "${input}" as ETB`);
  }
  const [, sign, whole = "0", frac = ""] = match;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return santim(sign === "-" ? -cents : cents);
}

export const ZERO: Santim = 0 as Santim;

export function add(a: Santim, b: Santim): Santim {
  return santim(a + b);
}

export function subtract(a: Santim, b: Santim): Santim {
  return santim(a - b);
}

/** Multiply by a whole quantity (line item: unit price × qty). */
export function multiply(a: Santim, quantity: number): Santim {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new MoneyError(`quantity must be a non-negative integer, got ${quantity}`);
  }
  return santim(a * quantity);
}

export function sum(values: readonly Santim[]): Santim {
  return values.reduce<Santim>((acc, v) => add(acc, v), ZERO);
}

/**
 * Apply a rate (tax, discount, commission) with explicit rounding.
 * Default is half-up, the convention Ethiopian accounting expects.
 */
export function applyRate(
  amount: Santim,
  rate: number,
  rounding: "half-up" | "down" | "up" = "half-up",
): Santim {
  const raw = amount * rate;
  switch (rounding) {
    case "down":
      return santim(Math.floor(raw));
    case "up":
      return santim(Math.ceil(raw));
    case "half-up":
      return santim(Math.round(raw));
  }
}

/**
 * Split an amount into n parts with no santim lost. The remainder is
 * distributed one santim at a time to the earliest parts, which is the
 * standard allocation rule for splitting a discount across line items.
 */
export function allocate(amount: Santim, parts: number): Santim[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new MoneyError(`parts must be a positive integer, got ${parts}`);
  }
  const base = Math.floor(amount / parts);
  const remainder = amount - base * parts;
  return Array.from({ length: parts }, (_, i) =>
    santim(base + (i < remainder ? 1 : 0)),
  );
}

/**
 * Convert to the major-unit number SantimPay's JSON API expects.
 * This is the ONLY place a float is allowed to exist, and only in flight.
 */
export function toGatewayAmount(amount: Santim): number {
  return Number((amount / 100).toFixed(2));
}

/** Convert a gateway-reported amount (string or number) back to santim. */
export function fromGatewayAmount(value: string | number): Santim {
  return typeof value === "number" ? birr(value) : parseBirr(value);
}

/** Human-facing format, e.g. "ETB 1,234.50". */
export function format(amount: Santim, locale = "en-ET"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "ETB",
    minimumFractionDigits: 2,
  }).format(amount / 100);
}
