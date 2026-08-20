/**
 * Integration test — requires a real Postgres. The property that matters
 * most: a customer editing or deleting an address they don't own must get
 * exactly the same result as the address not existing at all — never a
 * distinguishable "forbidden" vs "not found" — same discipline as
 * get-user-orders.ts's own comment on customer order scoping.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  createAddress,
  deleteAddress,
  listAddressesForUser,
  saveAddressFromCheckout,
  updateAddress,
  AddressError,
} from "./address-service.ts";

const prisma = new PrismaClient();

async function makeUser(suffix: string) {
  const user = await prisma.user.create({ data: { email: `address-test-${suffix}@example.et`, role: "CUSTOMER" } });
  return user.id;
}

test("creating an address validates real required fields", async () => {
  const userId = await makeUser(Math.random().toString(36).slice(2, 8));

  await assert.rejects(
    () => createAddress(userId, { fullName: "A", phone: "0912345678", city: "Addis Ababa" }),
    (err: unknown) => err instanceof AddressError && /full name/i.test(err.message),
  );
  await assert.rejects(
    () => createAddress(userId, { fullName: "Real Name", phone: "123", city: "Addis Ababa" }),
    (err: unknown) => err instanceof AddressError && /phone/i.test(err.message),
  );
});

test("a created address is real, persisted, and scoped to its owner", async () => {
  const userId = await makeUser(Math.random().toString(36).slice(2, 8));

  const address = await createAddress(userId, {
    fullName: "Abebe Kebede",
    phone: "0912345678",
    city: "Addis Ababa",
    subCity: "Bole",
    streetLine: "Bole Road",
    landmark: "near Edna Mall",
  });

  const listed = await listAddressesForUser(userId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, address.id);
  assert.equal(listed[0]!.subCity, "Bole");
  assert.equal(listed[0]!.landmark, "near Edna Mall");
});

test("a customer cannot update or delete another customer's address — indistinguishable from not found", async () => {
  const ownerId = await makeUser(`owner-${Math.random().toString(36).slice(2, 8)}`);
  const strangerId = await makeUser(`stranger-${Math.random().toString(36).slice(2, 8)}`);

  const address = await createAddress(ownerId, { fullName: "Owner Name", phone: "0911111111", city: "Addis Ababa" });

  await assert.rejects(
    () => updateAddress(strangerId, address.id, { fullName: "Hijacked", phone: "0922222222", city: "Elsewhere" }),
    (err: unknown) => err instanceof AddressError && /not found/i.test(err.message),
  );
  await assert.rejects(
    () => deleteAddress(strangerId, address.id),
    (err: unknown) => err instanceof AddressError && /not found/i.test(err.message),
  );

  const untouched = await prisma.address.findUniqueOrThrow({ where: { id: address.id } });
  assert.equal(untouched.fullName, "Owner Name", "the cross-user attempts must not have changed anything");
});

test("the real owner can update and then delete their own address", async () => {
  const userId = await makeUser(Math.random().toString(36).slice(2, 8));
  const address = await createAddress(userId, { fullName: "Original Name", phone: "0911111111", city: "Addis Ababa" });

  await updateAddress(userId, address.id, { fullName: "Updated Name", phone: "0922222222", city: "Adama" });
  const updated = await prisma.address.findUniqueOrThrow({ where: { id: address.id } });
  assert.equal(updated.fullName, "Updated Name");
  assert.equal(updated.city, "Adama");

  await deleteAddress(userId, address.id);
  const gone = await prisma.address.findUnique({ where: { id: address.id } });
  assert.equal(gone, null);
});

test("saveAddressFromCheckout silently skips malformed input rather than throwing after payment", async () => {
  const userId = await makeUser(Math.random().toString(36).slice(2, 8));

  // Must not throw — this runs after a real order has already been placed.
  await saveAddressFromCheckout(userId, { fullName: "", phone: "", city: "" });

  const listed = await listAddressesForUser(userId);
  assert.equal(listed.length, 0, "malformed checkout input must not create a garbage address row");
});

test("saveAddressFromCheckout persists a real, valid address", async () => {
  const userId = await makeUser(Math.random().toString(36).slice(2, 8));

  await saveAddressFromCheckout(userId, {
    fullName: "Checkout Saved Name",
    phone: "0933333333",
    city: "Addis Ababa",
    streetLine: "Some Street",
  });

  const listed = await listAddressesForUser(userId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.fullName, "Checkout Saved Name");
});

test.after(async () => {
  await prisma.address.deleteMany({ where: { user: { email: { startsWith: "address-test-" } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "address-test-" } } });
  await prisma.$disconnect();
});
