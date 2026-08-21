-- The DROP INDEX/ALTER COLUMN statements Prisma originally generated for
-- "products"."searchVector" here were spurious, same as every prior
-- migration that's touched anything nearby this session — Prisma's diff
-- engine doesn't understand a real GENERATED ALWAYS AS ... STORED column,
-- only the Unsupported("tsvector") placeholder. Removed by hand.

-- IF NOT EXISTS: this migration was amended (added notificationCount)
-- after its first attempt had already applied the enum addition for
-- real — Postgres has no ALTER TYPE ... DROP VALUE, so a plain retry
-- would fail with "enum label already exists" the same way every other
-- amended-after-partial-apply migration this session needed this fix for.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'BACK_IN_STOCK';

-- CreateTable
CREATE TABLE "back_in_stock_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "notificationCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "back_in_stock_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "back_in_stock_requests_variantId_notifiedAt_idx" ON "back_in_stock_requests"("variantId", "notifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "back_in_stock_requests_userId_variantId_key" ON "back_in_stock_requests"("userId", "variantId");

-- AddForeignKey
ALTER TABLE "back_in_stock_requests" ADD CONSTRAINT "back_in_stock_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "back_in_stock_requests" ADD CONSTRAINT "back_in_stock_requests_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
