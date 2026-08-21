/**
 * Guest order lookup — the real page behind the site footer's "Order
 * lookup" link, which had sat there as inert placeholder text (a plain
 * `<p>`, never a link) with nothing built behind it.
 *
 * A guest has no account/session to scope an order to, so this pairs the
 * order number with the email address used at checkout as the real
 * credential — the same standard pattern real e-commerce guest-tracking
 * uses (eBay, Amazon guest checkout). Order numbers alone are already
 * treated as "hard to guess, not a secret" elsewhere in this codebase
 * (see get-order-status.ts's own comment on the Crockford Base32
 * keyspace) — pairing with email is what keeps a full line-item/address
 * lookup from being open to anyone who can guess or intercept a bare
 * order number.
 *
 * Returns null for BOTH "no such order" and "email doesn't match" —
 * never distinguishable, same discipline as every ownership-scoped query
 * in this codebase: telling an attacker WHICH part was wrong turns this
 * into an email-enumeration oracle.
 */

import { prisma } from "../db.js";

export async function getOrderForGuestLookup(orderNumber: string, email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!orderNumber.trim() || !normalizedEmail) return null;

  const order = await prisma.order.findUnique({
    where: { orderNumber: orderNumber.trim().toUpperCase() },
    include: {
      lines: { include: { returnRequest: true } },
      payments: {
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, channel: true, channelRef: true, completedAt: true },
      },
    },
  });
  if (!order) return null;
  if (order.email.trim().toLowerCase() !== normalizedEmail) return null;

  return order;
}
