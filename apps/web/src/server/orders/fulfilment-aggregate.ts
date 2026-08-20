/**
 * Order.fulfilmentStatus is a DERIVED aggregate of its OrderLines' own
 * fulfilmentStatus — not a second, independently-mutable source of truth.
 * A multi-seller order needs per-line fulfilment (seller A can ship their
 * item while seller B hasn't; a single Order-level field can't represent
 * that — see schema.prisma's own comment on OrderLine.fulfilmentStatus).
 *
 * Deliberately PURE — no database, no import of `../db.js` even
 * transitively — same discipline and same real constraint as
 * seller-state-machine.ts's own module comment: `test:unit` runs under
 * plain `node --experimental-strip-types`, which cannot resolve a real
 * cross-file value import of anything that pulls in db.js.
 */

export type LineFulfilmentStatus = "UNFULFILLED" | "PARTIALLY_FULFILLED" | "FULFILLED" | "RETURNED";

/**
 * RETURNED lines are excluded from the fulfilled/unfulfilled count — a
 * returned item isn't "still needs shipping," it's a separate concern
 * (the future returns workflow). An order where every line is RETURNED
 * is reported UNFULFILLED here (nothing to ship) rather than a
 * nonsensical "FULFILLED" — the returns feature is expected to set its
 * own, more specific Order-level status when it exists.
 */
export function deriveOrderFulfilmentStatus(lineStatuses: readonly LineFulfilmentStatus[]): LineFulfilmentStatus {
  const relevant = lineStatuses.filter((s) => s !== "RETURNED");
  if (relevant.length === 0) return "UNFULFILLED";

  const fulfilledCount = relevant.filter((s) => s === "FULFILLED").length;
  if (fulfilledCount === 0) return "UNFULFILLED";
  if (fulfilledCount === relevant.length) return "FULFILLED";
  return "PARTIALLY_FULFILLED";
}
