-- The DROP INDEX/ALTER COLUMN statements Prisma originally generated for
-- "products"."searchVector" here were spurious, same as the wishlist
-- migration before this one — Prisma's diff engine doesn't understand a
-- real GENERATED ALWAYS AS ... STORED column, only the
-- Unsupported("tsvector") placeholder, and tries to "fix" a phantom drift
-- on every migration that touches anything nearby. Removed by hand.

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ORDER_PAID', 'ORDER_PAYMENT_FAILED', 'ORDER_LINE_FULFILLED', 'RETURN_APPROVED', 'RETURN_REJECTED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "dedupeKey" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications"("dedupeKey");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
