/**
 * GET /admin/users/export — downloads the current search as CSV. Same
 * discipline as /admin/orders/export's own Route Handler: never wrapped
 * by the co-located layout's guard, so this checks its own authorization
 * directly.
 */

import { requireRole } from "@/server/auth/guard";
import { exportUsersCsv } from "@/server/admin/admin-queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  await requireRole("STAFF");

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? undefined;

  const csv = await exportUsersCsv(q);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="users-export.csv"`,
    },
  });
}
