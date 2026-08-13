/**
 * One-time bootstrap: create (or promote) the first admin account.
 *
 * Runs OUTSIDE Next's request pipeline (a plain script, same as the worker —
 * see server/auth/session-store.ts's module comment on why that means it
 * cannot import session.ts). It therefore hashes the password and writes the
 * User row directly, then stops — it does NOT create a session, because
 * there is no cookie jar to put one in here. Sign in normally at
 * /admin/login afterward.
 *
 * Usage:
 *   BOOTSTRAP_ADMIN_EMAIL=you@example.et BOOTSTRAP_ADMIN_PASSWORD='...' \
 *     pnpm run create-admin
 *
 * Idempotent: re-running with the same email updates the password and
 * ensures the role is ADMIN, rather than failing on a duplicate — useful for
 * resetting a lost admin password without touching the database by hand.
 */

import { prisma } from "../src/server/db.ts";
import { hashPassword, PasswordError } from "../src/server/auth/password.ts";

async function main(): Promise<void> {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error(
      "Usage: BOOTSTRAP_ADMIN_EMAIL=you@example.et BOOTSTRAP_ADMIN_PASSWORD='...' pnpm run create-admin",
    );
    process.exitCode = 1;
    return;
  }

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (error) {
    if (error instanceof PasswordError) {
      console.error(`Password rejected: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const user = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, role: "ADMIN" },
    update: { passwordHash, role: "ADMIN" },
  });

  console.log(`✓ ${email} is now an ADMIN (user id ${user.id}). Sign in at /admin/login.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
