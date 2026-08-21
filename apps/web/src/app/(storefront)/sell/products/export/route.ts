/**
 * GET /sell/products/export — downloads the signed-in seller's own
 * catalogue as CSV. A page-style guard (redirect-based), not a bare JSON
 * 401, because this is only ever reached by a seller clicking a real link
 * from their own listings page — the same UX contract requireApprovedSellerForPage
 * already gives every other /sell/** page.
 */

import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { exportSellerProductsCsv } from "@/server/catalogue/listing-bulk-service";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const seller = await requireApprovedSellerForPage();
  const csv = await exportSellerProductsCsv(seller.id);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${seller.slug}-products.csv"`,
    },
  });
}
