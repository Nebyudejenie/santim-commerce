/**
 * The one shared entry point for enqueueing an outbox message — extracted
 * from payment-service.ts (its original, still-only-caller-until-now) so
 * other domains (seller fulfillment, returns) can enqueue their own topics
 * without an awkward cross-import into a payment-specific module.
 *
 * Side effects (notifications, settlement, anything a customer or seller
 * would notice) go through this, never a direct call inside the same
 * transaction that made the state change real — see worker/index.ts's own
 * comment: you cannot roll back an email, a push notification, or a
 * ledger entry that already left the building.
 */

import type { Tx } from "./db.js";

export async function enqueue(tx: Tx, topic: string, payload: object): Promise<void> {
  await tx.outboxMessage.create({ data: { topic, payload: payload as object } });
}
