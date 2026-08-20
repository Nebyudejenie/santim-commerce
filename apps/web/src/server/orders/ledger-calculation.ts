/**
 * The arithmetic half of seller settlement — deliberately PURE, no
 * database, same reasoning and same real constraint as
 * fulfilment-aggregate.ts/seller-state-machine.ts: `test:unit` runs under
 * plain `node --experimental-strip-types`, which cannot resolve a real
 * cross-file value import of anything that transitively touches db.js.
 *
 * Money in, money out, no float anywhere — see money.ts's own module
 * comment on why that's non-negotiable for anything touching a real
 * amount of money.
 */

export interface LedgerAmounts {
  /** Positive — gross revenue for this line. */
  readonly saleSantim: number;
  /** Negative (or zero) — the platform's cut, debited from the seller. */
  readonly commissionSantim: number;
  /** saleSantim + commissionSantim — what the seller actually nets. */
  readonly netPayableSantim: number;
}

/**
 * `commissionBps` is basis points (1000 = 10.00%), matching
 * Seller.commissionBps's own doc comment. Rounds to the nearest santim —
 * a fractional santim cannot exist (money.ts's `santim()` rejects
 * non-integers), and rounding here, once, at the one place commission is
 * actually computed, is the correct place for that to happen — not
 * scattered across every call site that reads a ledger entry later.
 */
export function computeLedgerAmounts(lineTotalSantim: number, commissionBps: number): LedgerAmounts {
  if (!Number.isInteger(lineTotalSantim) || lineTotalSantim < 0) {
    throw new RangeError(`lineTotalSantim must be a non-negative integer, got ${lineTotalSantim}`);
  }
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
    throw new RangeError(`commissionBps must be an integer in [0, 10000], got ${commissionBps}`);
  }

  // `|| 0` normalizes JavaScript's negative zero: -Math.round(0) is -0, not
  // 0 — real, caught by a real test (Node's assert.strict distinguishes
  // them via Object.is). Harmless once persisted to a Postgres INTEGER
  // column (which has no negative zero), but wrong to let sit in application
  // code that a future caller might compare with Object.is or serialize.
  const commissionSantim = (-Math.round((lineTotalSantim * commissionBps) / 10_000)) || 0;
  return {
    saleSantim: lineTotalSantim,
    commissionSantim,
    netPayableSantim: lineTotalSantim + commissionSantim,
  };
}
