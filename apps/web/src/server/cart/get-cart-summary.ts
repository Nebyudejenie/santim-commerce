import { prisma } from "../db.js";
import { readCartToken } from "./cart-cookie.js";

/** Item count for the header badge. Reads only — never creates a cart. */
export async function getCartItemCount(): Promise<number> {
  const token = await readCartToken();
  if (!token) return 0;

  const cart = await prisma.cart.findUnique({
    where: { token },
    select: { status: true, lines: { select: { quantity: true } } },
  });
  if (!cart || cart.status !== "ACTIVE") return 0;

  return cart.lines.reduce((sum, l) => sum + l.quantity, 0);
}
