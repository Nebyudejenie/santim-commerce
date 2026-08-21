"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { AuthError, hasRole, login, logout, register } from "../auth/auth-service.js";
import { destroySession } from "../auth/session.js";
import { PasswordError } from "../auth/password.js";
import { resetPasswordWithToken, PasswordResetError } from "../auth/password-reset-service.js";
import { mergeGuestCartIntoUser } from "../cart/cart-service.js";
import { logger } from "../observability/logger.js";

export interface AuthFormState {
  readonly ok: boolean;
  readonly error?: string;
}

const CART_COOKIE_NAME = "santim_cart";

/**
 * After a successful login/register, fold whatever the customer had in
 * their guest cart into their persistent one, then point the cart cookie at
 * the (possibly newly-merged) result. See cart-service.ts's
 * `mergeGuestCartIntoUser` for why this is more than a reassignment.
 */
async function adoptCartForUser(userId: string): Promise<void> {
  const store = await cookies();
  const guestToken = store.get(CART_COOKIE_NAME)?.value;
  const finalToken = await mergeGuestCartIntoUser(guestToken, userId);

  store.set(CART_COOKIE_NAME, finalToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });
}

export async function registerAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "").trim();

  try {
    const user = await register({ email, password, name: name || undefined });
    await adoptCartForUser(user.id);
  } catch (error) {
    if (error instanceof AuthError || error instanceof PasswordError) {
      return { ok: false, error: error.message };
    }
    logger.error("auth.register_action_failed", { error: (error as Error).message });
    return { ok: false, error: "Something went wrong creating your account. Please try again." };
  }

  revalidatePath("/", "layout");
  redirect("/account");
}

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const redirectTo = String(formData.get("redirectTo") ?? "/account");

  try {
    const user = await login({ email, password });
    await adoptCartForUser(user.id);
  } catch (error) {
    if (error instanceof AuthError) {
      return { ok: false, error: error.message };
    }
    logger.error("auth.login_action_failed", { error: (error as Error).message });
    return { ok: false, error: "Something went wrong signing you in. Please try again." };
  }

  revalidatePath("/", "layout");
  // Only ever redirect to a same-site relative path from user input — an
  // unvalidated `redirectTo` is an open-redirect vector (?redirectTo=https://evil.example).
  redirect(redirectTo.startsWith("/") && !redirectTo.startsWith("//") ? redirectTo : "/account");
}

export async function logoutAction(): Promise<void> {
  await logout();
  revalidatePath("/", "layout");
  redirect("/");
}

/**
 * Admin login is deliberately a SEPARATE action from the customer one, even
 * though both call the same `login()` — no cart-merge concept applies to a
 * staff sign-in, and a CUSTOMER-role account that guesses/knows correct
 * credentials must still be refused entry here. That refusal message CAN
 * say "you don't have admin access" rather than a generic failure: the
 * person has already proven they own those credentials by getting past
 * `login()`'s timing-safe check, so this reveals nothing an attacker
 * couldn't already infer from a generic account they don't control.
 */
export async function adminLoginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  let user;
  try {
    user = await login({ email, password });
  } catch (error) {
    if (error instanceof AuthError) {
      return { ok: false, error: error.message };
    }
    logger.error("auth.admin_login_action_failed", { error: (error as Error).message });
    return { ok: false, error: "Something went wrong signing you in. Please try again." };
  }

  if (!hasRole(user.role, "STAFF")) {
    await destroySession(); // login() above already created one — do not leave it live
    logger.warn("auth.admin_login_insufficient_role", { userId: user.id, role: user.role });
    return { ok: false, error: "This account does not have admin access." };
  }

  redirect("/admin");
}

/**
 * Public completion of the admin-assisted recovery flow — see
 * password-reset-service.ts's module comment for why the request side is
 * admin-issued rather than self-service. This action just spends a real,
 * already-issued token; the redirect to `/login` on success (not an
 * automatic sign-in) matches every existing session-establishing action
 * here going through the normal login path once, deliberately.
 */
export async function resetPasswordAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");

  try {
    await resetPasswordWithToken(token, password);
  } catch (error) {
    if (error instanceof PasswordResetError || error instanceof PasswordError) {
      return { ok: false, error: error.message };
    }
    logger.error("auth.reset_password_action_failed", { error: (error as Error).message });
    return { ok: false, error: "Something went wrong. Please try again." };
  }

  redirect("/login");
}
