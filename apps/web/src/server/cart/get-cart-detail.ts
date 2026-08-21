import { prisma } from "../db.js";
import { readCartToken } from "./cart-cookie.js";
import { cartSubtotalSantim, priceCartLines, type CartLineLike } from "./cart-service.js";
import { totalAvailable } from "../catalogue/catalogue-service.js";

export async function getCartDetail() {
  const token = await readCartToken();
  if (!token) return null;

  const cart = await prisma.cart.findUnique({
    where: { token },
    include: {
      lines: {
        orderBy: { createdAt: "asc" },
        include: {
          variant: {
            include: {
              product: { select: { title: true, slug: true, heroImage: true, sellerId: true } },
              inventory: true,
            },
          },
        },
      },
    },
  });

  if (!cart || cart.status !== "ACTIVE" || cart.lines.length === 0) return null;

  const priced = priceCartLines(cart.lines as unknown as CartLineLike[]);
  const subtotalSantim = cartSubtotalSantim(priced);

  const lines = cart.lines.map((line) => {
    const p = priced.find((x) => x.variantId === line.variantId)!;
    // Reuses catalogue-service.ts's own shared definition — see its
    // comment on why a backorder-enabled, real-stock-exhausted variant
    // must not show a false "exceeds available stock" warning here.
    const available = totalAvailable(line.variant.inventory);
    return {
      variantId: line.variantId,
      sellerId: line.variant.product.sellerId,
      productTitle: line.variant.product.title,
      productSlug: line.variant.product.slug,
      variantTitle: line.variant.title,
      image: line.variant.product.heroImage,
      quantity: line.quantity,
      unitPriceSantim: p.currentPriceSantim,
      priceChanged: p.priceChanged,
      lineTotalSantim: p.lineTotalSantim,
      available,
      exceedsAvailable: line.quantity > available,
    };
  });

  return {
    token,
    lines,
    subtotalSantim,
    hasPriceChanges: lines.some((l) => l.priceChanged),
    hasStockIssues: lines.some((l) => l.exceedsAvailable),
  };
}

export type CartDetail = NonNullable<Awaited<ReturnType<typeof getCartDetail>>>;
