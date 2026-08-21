-- The DROP INDEX/ALTER COLUMN statements Prisma originally generated for
-- "products"."searchVector" here were spurious, same as every prior
-- migration that's touched anything nearby this session — Prisma's diff
-- engine doesn't understand a real GENERATED ALWAYS AS ... STORED column,
-- only the Unsupported("tsvector") placeholder. Removed by hand.

-- AlterEnum
ALTER TYPE "LedgerEntryType" ADD VALUE 'COUPON_DISCOUNT';

-- AlterTable
ALTER TABLE "coupons" ADD COLUMN     "sellerId" TEXT;

-- CreateIndex
CREATE INDEX "coupons_sellerId_idx" ON "coupons"("sellerId");

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
