"use server";

/**
 * Address book mutations — checks its own authorization via requireUser,
 * same in-action-auth discipline as every other action in this codebase.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "../auth/guard.js";
import {
  createAddress,
  deleteAddress,
  updateAddress,
  AddressError,
  type AddressInput,
} from "../addresses/address-service.js";
import { logger } from "../observability/logger.js";

export interface AddressActionState {
  readonly ok: boolean;
  readonly message?: string;
}

function readAddressInput(formData: FormData): AddressInput {
  return {
    fullName: String(formData.get("fullName") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    city: String(formData.get("city") ?? ""),
    subCity: String(formData.get("subCity") ?? "") || undefined,
    woreda: String(formData.get("woreda") ?? "") || undefined,
    streetLine: String(formData.get("streetLine") ?? "") || undefined,
    landmark: String(formData.get("landmark") ?? "") || undefined,
    notes: String(formData.get("notes") ?? "") || undefined,
  };
}

export async function createAddressAction(
  _prev: AddressActionState,
  formData: FormData,
): Promise<AddressActionState> {
  const user = await requireUser();

  try {
    await createAddress(user.id, readAddressInput(formData));
  } catch (error) {
    if (error instanceof AddressError) return { ok: false, message: error.message };
    logger.error("address.create_action_failed", { userId: user.id, error: (error as Error).message });
    return { ok: false, message: "Something went wrong saving that address. Please try again." };
  }

  revalidatePath("/account/addresses");
  return { ok: true, message: "Address saved." };
}

export async function updateAddressAction(
  _prev: AddressActionState,
  formData: FormData,
): Promise<AddressActionState> {
  const user = await requireUser();
  const addressId = String(formData.get("addressId") ?? "");
  if (!addressId) return { ok: false, message: "Missing address id." };

  try {
    await updateAddress(user.id, addressId, readAddressInput(formData));
  } catch (error) {
    if (error instanceof AddressError) return { ok: false, message: error.message };
    logger.error("address.update_action_failed", { userId: user.id, addressId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/account/addresses");
  return { ok: true, message: "Address updated." };
}

export async function deleteAddressAction(
  _prev: AddressActionState,
  formData: FormData,
): Promise<AddressActionState> {
  const user = await requireUser();
  const addressId = String(formData.get("addressId") ?? "");
  if (!addressId) return { ok: false, message: "Missing address id." };

  try {
    await deleteAddress(user.id, addressId);
  } catch (error) {
    if (error instanceof AddressError) return { ok: false, message: error.message };
    logger.error("address.delete_action_failed", { userId: user.id, addressId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/account/addresses");
  return { ok: true, message: "Address removed." };
}
