/**
 * Cart identity lives in an httpOnly cookie, not in a client-readable one and
 * not in the URL. It is a bearer credential for the cart's contents — the
 * same reasoning as a session id — so JavaScript must never be able to read
 * it (XSS exfiltration) and it must never end up in a server access log via
 * a query string.
 */

import { cookies } from "next/headers";
import { generateCartToken } from "./cart-service.js";

const COOKIE_NAME = "santim_cart";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days, matching Cart.expiresAt

export async function readCartToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value;
}

/** Ensures a cart cookie exists, creating one if this is a first-time visitor. */
export async function ensureCartToken(): Promise<string> {
  const store = await cookies();
  const existing = store.get(COOKIE_NAME)?.value;
  if (existing) return existing;

  const token = generateCartToken();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
  return token;
}

export async function clearCartToken(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
