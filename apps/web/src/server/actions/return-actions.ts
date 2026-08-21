"use server";

/**
 * Return-request mutations — checks its own authorization
 * (requireUser/requireApprovedSeller/requireRole), same in-action-auth
 * discipline as every other action added this session.
 */

import { revalidatePath } from "next/cache";
import { requireRole, requireUser } from "../auth/guard.js";
import { requireApprovedSeller, SellerError } from "../sellers/seller-service.js";
import {
  approveReturnAsAdmin,
  approveReturnAsSeller,
  disputeReturnRejection,
  rejectReturnAsAdmin,
  rejectReturnAsSeller,
  requestReturn,
  ReturnError,
} from "../orders/return-service.js";
import { logger } from "../observability/logger.js";

export interface ReturnActionState {
  readonly ok: boolean;
  readonly message?: string;
}

export async function requestReturnAction(
  _prev: ReturnActionState,
  formData: FormData,
): Promise<ReturnActionState> {
  const user = await requireUser();
  const orderLineId = String(formData.get("orderLineId") ?? "");
  const orderNumber = String(formData.get("orderNumber") ?? "");
  const reason = String(formData.get("reason") ?? "");

  try {
    await requestReturn(user.id, orderLineId, reason);
  } catch (error) {
    if (error instanceof ReturnError) return { ok: false, message: error.message };
    logger.error("return.request_action_failed", { orderLineId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  if (orderNumber) revalidatePath(`/account/orders/${orderNumber}`);
  return { ok: true, message: "Return requested — the seller will review it." };
}

export async function disputeReturnAction(
  _prev: ReturnActionState,
  formData: FormData,
): Promise<ReturnActionState> {
  const user = await requireUser();
  const returnRequestId = String(formData.get("returnRequestId") ?? "");
  const orderNumber = String(formData.get("orderNumber") ?? "");
  const reason = String(formData.get("reason") ?? "");

  try {
    await disputeReturnRejection(user.id, returnRequestId, reason);
  } catch (error) {
    if (error instanceof ReturnError) return { ok: false, message: error.message };
    logger.error("return.dispute_action_failed", { returnRequestId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  if (orderNumber) revalidatePath(`/account/orders/${orderNumber}`);
  revalidatePath("/admin/returns");
  return { ok: true, message: "Escalated to admin for a final decision." };
}

async function sellerIdOrState(): Promise<string | ReturnActionState> {
  const user = await requireUser();
  try {
    const seller = await requireApprovedSeller(user.id);
    return seller.id;
  } catch (error) {
    return { ok: false, message: error instanceof SellerError ? error.message : "Not authorized." };
  }
}

export async function approveReturnAction(
  _prev: ReturnActionState,
  formData: FormData,
): Promise<ReturnActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  const returnRequestId = String(formData.get("returnRequestId") ?? "");
  const note = String(formData.get("note") ?? "");

  try {
    await approveReturnAsSeller(sellerId, returnRequestId, note || undefined);
  } catch (error) {
    if (error instanceof ReturnError) return { ok: false, message: error.message };
    logger.error("return.approve_action_failed", { returnRequestId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/sell/returns");
  return { ok: true, message: "Return approved — inventory restocked." };
}

export async function rejectReturnAction(
  _prev: ReturnActionState,
  formData: FormData,
): Promise<ReturnActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  const returnRequestId = String(formData.get("returnRequestId") ?? "");
  const note = String(formData.get("note") ?? "");

  try {
    await rejectReturnAsSeller(sellerId, returnRequestId, note || undefined);
  } catch (error) {
    if (error instanceof ReturnError) return { ok: false, message: error.message };
    logger.error("return.reject_action_failed", { returnRequestId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/sell/returns");
  return { ok: true, message: "Return rejected." };
}

export async function adminApproveReturnAction(
  _prev: ReturnActionState,
  formData: FormData,
): Promise<ReturnActionState> {
  const admin = await requireRole("STAFF");
  const returnRequestId = String(formData.get("returnRequestId") ?? "");

  try {
    await approveReturnAsAdmin(admin.id, returnRequestId, "Admin override.");
  } catch (error) {
    if (error instanceof ReturnError) return { ok: false, message: error.message };
    logger.error("return.admin_approve_action_failed", { returnRequestId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/admin/returns");
  return { ok: true, message: "Return approved (admin override)." };
}

export async function adminRejectReturnAction(
  _prev: ReturnActionState,
  formData: FormData,
): Promise<ReturnActionState> {
  const admin = await requireRole("STAFF");
  const returnRequestId = String(formData.get("returnRequestId") ?? "");

  try {
    await rejectReturnAsAdmin(admin.id, returnRequestId, "Admin override.");
  } catch (error) {
    if (error instanceof ReturnError) return { ok: false, message: error.message };
    logger.error("return.admin_reject_action_failed", { returnRequestId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/admin/returns");
  return { ok: true, message: "Return rejected (admin override)." };
}
