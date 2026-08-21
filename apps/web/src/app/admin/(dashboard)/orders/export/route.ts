/**
 * GET /admin/orders/export — downloads the current order filter as CSV,
 * for reconciliation/accounting. `(dashboard)/layout.tsx`'s own
 * `requireRole("STAFF")` guard wraps PAGE rendering only — a Route
 * Handler is never wrapped by a co-located layout, even nested in the
 * same segment — so this checks its own authorization directly, same
 * discipline as /sell/products/export's own route handler.
 */

import { requireRole } from "@/server/auth/guard";
import { exportOrdersCsv, type OrderStatus } from "@/server/admin/admin-queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  await requireRole("STAFF");

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? undefined;
  const q = searchParams.get("q") ?? undefined;

  const csv = await exportOrdersCsv({ status: status as OrderStatus | undefined, search: q });

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-export.csv"`,
    },
  });
}
