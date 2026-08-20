-- Multi-vendor marketplace foundation: every Product now belongs to a
-- Seller. Hand-written, not `prisma migrate dev`-generated, because this
-- table has real existing rows (8 seed products) and a plain
-- ADD COLUMN ... NOT NULL would destroy them — Prisma's own migrate dev
-- refused to auto-generate this for exactly that reason. This is a real
-- expand → backfill → contract migration, safe to run against a live
-- table with data, not just against this empty dev database.

-- ============================================================ 1. expand

-- CreateEnum
CREATE TYPE "SellerStatus" AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED');

-- CreateTable
CREATE TABLE "sellers" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "logoUrl" TEXT,
    "status" "SellerStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "rejectionReason" TEXT,
    "commissionBps" INTEGER NOT NULL DEFAULT 1000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sellers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sellers_ownerId_key" ON "sellers"("ownerId");
CREATE UNIQUE INDEX "sellers_slug_key" ON "sellers"("slug");
CREATE INDEX "sellers_status_idx" ON "sellers"("status");

-- products.sellerId: nullable for now, made required after backfill below.
ALTER TABLE "products" ADD COLUMN "sellerId" TEXT;

-- order_lines.sellerId: the table is empty in every environment this
-- migration has run against so far (no order has ever been placed against
-- this schema version) — safe to add directly as required, no backfill
-- needed. If that stops being true before this deploys somewhere, this
-- statement will fail loudly (NOT NULL violation) rather than silently
-- corrupting data, which is the correct failure mode.
ALTER TABLE "order_lines" ADD COLUMN "sellerId" TEXT NOT NULL;
ALTER TABLE "order_lines" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ========================================================== 2. backfill

-- Every product that existed before this migration gets attributed to one
-- real, explicit "legacy catalogue" seller — never left ownerless. A real
-- deployment with real historical products would want a human decision
-- about actual per-product seller attribution instead; this exists so the
-- constraint can be enforced without deleting or guessing at real data.
INSERT INTO "users" ("id", "email", "role", "createdAt", "updatedAt")
VALUES ('legacy-catalog-owner', 'legacy-catalog@example.et', 'CUSTOMER', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "sellers" ("id", "ownerId", "storeName", "slug", "status", "reviewedAt", "reviewedBy", "createdAt", "updatedAt")
VALUES ('legacy-catalog-seller', 'legacy-catalog-owner', 'Legacy Catalogue', 'legacy-catalogue', 'APPROVED', CURRENT_TIMESTAMP, 'migration:add_multi_vendor_seller_domain', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

UPDATE "products" SET "sellerId" = 'legacy-catalog-seller' WHERE "sellerId" IS NULL;

-- =========================================================== 3. contract

ALTER TABLE "products" ALTER COLUMN "sellerId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "products_sellerId_status_idx" ON "products"("sellerId", "status");
CREATE INDEX "order_lines_sellerId_createdAt_idx" ON "order_lines"("sellerId", "createdAt");

-- ============================================= 4. variant.sku rescoping
--
-- SKUs move from globally unique to unique-per-product (see schema.prisma's
-- own comment: two different sellers reusing "BLK-M" is normal, not a
-- collision). Dropping the old constraint before adding the new one is
-- safe here — grep confirms no application code does a `where: { sku }`
-- lookup anywhere; the only real usage is reading `variant.sku` off an
-- already-fetched row to snapshot it onto an order line.

DROP INDEX "variants_sku_key";
CREATE UNIQUE INDEX "variants_productId_sku_key" ON "variants"("productId", "sku");
