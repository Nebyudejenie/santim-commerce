/**
 * GET /account/data-export — downloads the signed-in user's own data as
 * JSON. Same page-style-guard convention as /sell/products/export's own
 * Route Handler: only ever reached via a real link from /account/security,
 * so a redirect-based guard (requireUser) is the right UX, not a bare 401.
 */

import { requireUser } from "@/server/auth/guard";
import { exportUserData } from "@/server/account/data-export-service";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await requireUser();
  const data = await exportUserData(user.id);

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="my-data-${user.id}.json"`,
    },
  });
}
