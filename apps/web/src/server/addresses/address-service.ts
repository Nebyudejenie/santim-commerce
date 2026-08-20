/**
 * Address book: a signed-in customer's saved delivery addresses.
 *
 * OWNERSHIP IS THE WHOLE POINT of every function below that takes an
 * addressId — a customer reading, editing, or deleting an address they
 * don't own must get exactly the same result as the address not existing,
 * never a distinguishable "forbidden" vs "not found". Same discipline as
 * get-user-orders.ts's own comment on customer order scoping.
 *
 * This does NOT change how checkout stores an address: Order.shippingAddress
 * stays a snapshotted JSON blob (an order is a historical record, not a
 * live reference — the same reasoning OrderLine's own schema comment gives
 * for snapshotting price/product data). A saved Address is only ever a
 * convenient INPUT SOURCE for the checkout form to prefill from, never a
 * foreign key the order depends on — editing or deleting a saved address
 * later must never be able to alter a past order's real shipping address.
 */

import { prisma } from "../db.js";

export class AddressError extends Error {
  override name = "AddressError";
}

export interface AddressInput {
  readonly fullName: string;
  readonly phone: string;
  readonly city: string;
  readonly subCity?: string;
  readonly woreda?: string;
  readonly streetLine?: string;
  readonly landmark?: string;
  readonly notes?: string;
}

function validate(input: AddressInput): void {
  if (input.fullName.trim().length < 2) {
    throw new AddressError("Enter a full name.");
  }
  if (input.phone.trim().length < 6) {
    throw new AddressError("Enter a valid phone number.");
  }
  if (input.city.trim().length < 2) {
    throw new AddressError("Enter a city.");
  }
}

export async function listAddressesForUser(userId: string) {
  return prisma.address.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

export async function getOwnedAddress(userId: string, addressId: string) {
  return prisma.address.findFirst({ where: { id: addressId, userId } });
}

export async function createAddress(userId: string, input: AddressInput) {
  validate(input);
  return prisma.address.create({
    data: {
      userId,
      fullName: input.fullName.trim(),
      phone: input.phone.trim(),
      city: input.city.trim(),
      subCity: input.subCity?.trim() || null,
      woreda: input.woreda?.trim() || null,
      streetLine: input.streetLine?.trim() || null,
      landmark: input.landmark?.trim() || null,
      notes: input.notes?.trim() || null,
    },
  });
}

export async function updateAddress(userId: string, addressId: string, input: AddressInput): Promise<void> {
  validate(input);
  const owned = await getOwnedAddress(userId, addressId);
  if (!owned) throw new AddressError("Address not found.");

  await prisma.address.update({
    where: { id: addressId },
    data: {
      fullName: input.fullName.trim(),
      phone: input.phone.trim(),
      city: input.city.trim(),
      subCity: input.subCity?.trim() || null,
      woreda: input.woreda?.trim() || null,
      streetLine: input.streetLine?.trim() || null,
      landmark: input.landmark?.trim() || null,
      notes: input.notes?.trim() || null,
    },
  });
}

export async function deleteAddress(userId: string, addressId: string): Promise<void> {
  const owned = await getOwnedAddress(userId, addressId);
  if (!owned) throw new AddressError("Address not found.");

  await prisma.address.delete({ where: { id: addressId } });
}

/**
 * Best-effort save from checkout — called AFTER a real order has already
 * been placed (see checkout-actions.ts), never inside checkout-service.ts's
 * transaction. Saving a convenience address must never be able to fail or
 * slow down a real payment flow; a duplicate near-identical address is a
 * cosmetic annoyance, not a correctness problem worth blocking checkout to
 * prevent.
 */
export async function saveAddressFromCheckout(userId: string, input: AddressInput): Promise<void> {
  if (input.fullName.trim().length < 2 || input.phone.trim().length < 6 || input.city.trim().length < 2) {
    return; // malformed input from a non-address-book source — silently skip, never throw post-payment
  }
  await prisma.address.create({
    data: {
      userId,
      fullName: input.fullName.trim(),
      phone: input.phone.trim(),
      city: input.city.trim(),
      subCity: input.subCity?.trim() || null,
      woreda: input.woreda?.trim() || null,
      streetLine: input.streetLine?.trim() || null,
      landmark: input.landmark?.trim() || null,
    },
  });
}
