/**
 * Seller status transitions. Deliberately PURE — no database, no network,
 * no import of `../db.js` even transitively — same discipline as
 * orders/state-machine.ts's own module comment: this is what makes the
 * rules exhaustively unit-testable under plain `node --experimental-strip-
 * types` (test:unit), which cannot resolve a real cross-file value import
 * of anything that itself imports `db.js` (confirmed the hard way —
 * ERR_MODULE_NOT_FOUND — before this file existed as its own module).
 *
 * A local string-union type, not `@prisma/client`'s generated `SellerStatus`
 * enum, for the identical reason orders/state-machine.ts defines its own
 * OrderStatus/PaymentStatus rather than importing them: this module must
 * stay decoupled from the database layer entirely, and the two are kept in
 * sync by the integration test, not by a type import.
 */

export type SellerStatus = "PENDING" | "APPROVED" | "SUSPENDED" | "REJECTED";

const VALID_TRANSITIONS: Record<SellerStatus, readonly SellerStatus[]> = {
  PENDING: ["APPROVED", "REJECTED"],
  APPROVED: ["SUSPENDED"],
  SUSPENDED: ["APPROVED"],
  REJECTED: [], // terminal — see seller-service.ts's applyToBecomeSeller for how a rejected applicant proceeds
};

export function canTransitionSeller(from: SellerStatus, to: SellerStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}
