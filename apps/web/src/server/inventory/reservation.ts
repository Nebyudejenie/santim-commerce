/**
 * Concurrency-safe inventory reservation.
 *
 * THE PROBLEM
 * -----------
 * Two customers open the product page for the last unit in stock within the
 * same second. Both pass the "is it in stock?" check, because both check
 * BEFORE either writes anything — the classic check-then-act race. Both
 * proceed to checkout. One of them is about to pay for something you cannot
 * ship.
 *
 * THE FIX THAT DOES NOT WORK
 * ---------------------------
 * ```ts
 * const inv = await prisma.inventory.findUnique({ where: { variantId } });
 * if (inv.onHand - inv.reserved >= qty) {
 *   await prisma.inventory.update({ where: { variantId }, data: { reserved: { increment: qty } } });
 * }
 * ```
 * The read and the write are two round-trips. Between them, another request
 * can do the same read, see the same (still-available) numbers, and also
 * proceed. Under load this is not a rare edge case — it is Tuesday.
 *
 * THE FIX THAT WORKS
 * -------------------
 * Fold the check and the write into ONE statement, so Postgres's own row
 * locking serialises it for us instead of us trying to out-think the
 * scheduler:
 *
 *   UPDATE inventory
 *      SET reserved = reserved + $qty
 *    WHERE variant_id = $id
 *      AND (on_hand - reserved) >= $qty
 *
 * Postgres takes a row lock for the duration of the UPDATE. A second
 * concurrent UPDATE against the same row queues behind it, and — because this
 * runs under READ COMMITTED, Postgres's default — re-evaluates the WHERE
 * clause against the now-current row once the lock is released, rather than
 * against the stale snapshot it started with. So the second caller sees the
 * first caller's decrement and correctly fails.
 *
 * This is why the query is raw SQL rather than a Prisma `update()`: Prisma's
 * filter DSL cannot express a comparison between two columns of the same row
 * (`on_hand - reserved >= quantity`). That expressiveness gap is a normal
 * reason to drop to `$queryRaw`/`$executeRaw` — not a workaround, the correct
 * tool for this specific job. The values are still fully parameterised, so
 * there is no SQL injection surface.
 */

import { Prisma } from "@prisma/client";
import type { Tx } from "../db.js";

export class InsufficientStockError extends Error {
  override name = "InsufficientStockError";
  readonly variantId: string;
  readonly requested: number;

  constructor(variantId: string, requested: number) {
    super(`Insufficient stock for variant ${variantId}: requested ${requested}`);
    this.variantId = variantId;
    this.requested = requested;
  }
}

export interface ReserveLine {
  readonly variantId: string;
  readonly quantity: number;
}

/**
 * Attempt to reserve a single variant. Returns true iff the reservation was
 * granted. The caller decides what "false" means (usually: roll back the
 * whole transaction and tell the customer this item is no longer available).
 */
async function tryReserveOne(tx: Tx, variantId: string, quantity: number): Promise<boolean> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(`quantity must be a positive integer, got ${quantity}`);
  }

  // `allowBackorder` lets a merchant deliberately oversell a specific variant
  // (made-to-order items); the condition is part of the same atomic statement
  // rather than a separate branch, so there is still exactly one round-trip
  // and no reintroduced race between checking the flag and writing the row.
  // Column names are quoted camelCase because Prisma does not snake_case
  // columns by default (no @map on these fields — see prisma/schema.prisma).
  // Unquoted identifiers would be folded to lowercase by Postgres and miss.
  const affected = await tx.$executeRaw`
    UPDATE "inventory"
       SET "reserved" = "reserved" + ${quantity}
     WHERE "variantId" = ${variantId}
       AND ("allowBackorder" = TRUE OR ("onHand" - "reserved") >= ${quantity})
  `;

  return affected === 1;
}

export interface ReservationHandle {
  readonly id: string;
  readonly variantId: string;
  readonly quantity: number;
}

/**
 * Reserve every line of an order atomically: all lines succeed, or none do.
 *
 * Lines are reserved in a STABLE order (sorted by variantId) before any write
 * happens. Without this, two checkouts buying the same two items in opposite
 * order (A-then-B vs B-then-A) can each hold one lock and wait on the other —
 * a classic deadlock. A fixed acquisition order makes that structurally
 * impossible: whichever request goes first always goes first for every item.
 *
 * On any line's failure, previously-granted reservations in THIS call are
 * released (via row updates in the same transaction) and
 * `InsufficientStockError` is thrown naming the failing variant, so the
 * caller can show the customer exactly what changed.
 */
export async function reserveForOrder(
  tx: Tx,
  orderId: string,
  lines: readonly ReserveLine[],
  expiresAt: Date,
): Promise<ReservationHandle[]> {
  const sorted = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
  const granted: ReservationHandle[] = [];

  for (const line of sorted) {
    const ok = await tryReserveOne(tx, line.variantId, line.quantity);
    if (!ok) {
      // The whole caller transaction rolls back on this throw, which also
      // undoes the `reserved` increments already applied above — we do not
      // need to manually decrement them.
      throw new InsufficientStockError(line.variantId, line.quantity);
    }

    const reservation = await tx.inventoryReservation.create({
      data: {
        variantId: line.variantId,
        orderId,
        quantity: line.quantity,
        status: "HELD",
        expiresAt,
      },
    });
    granted.push({ id: reservation.id, variantId: line.variantId, quantity: line.quantity });
  }

  return granted;
}

/** Available-to-sell count, for display. Never persisted — always derived. */
export async function getAvailable(tx: Tx, variantId: string): Promise<number> {
  const inv = await tx.inventory.findUnique({ where: { variantId } });
  if (!inv) return 0;
  return Math.max(0, inv.onHand - inv.reserved);
}

/** Re-exported so callers needn't reach into `@prisma/client` directly. */
export type { Prisma };
