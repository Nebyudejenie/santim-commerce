-- The DROP INDEX/ALTER COLUMN statements Prisma originally generated for
-- "products"."searchVector" here were spurious: Prisma's migration-diff
-- engine doesn't understand a real Postgres GENERATED ALWAYS AS ... STORED
-- column (it only sees the `Unsupported("tsvector")` placeholder in
-- schema.prisma) and tried to "fix" a phantom drift by dropping a default
-- that column has never had — see Product.searchVector's own comment in
-- schema.prisma. Removed by hand; every unrelated migration touching this
-- table from now on will need the same check before applying.

-- CreateTable
CREATE TABLE "wishlist_items" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wishlist_items_userId_createdAt_idx" ON "wishlist_items"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "wishlist_items_userId_productId_key" ON "wishlist_items"("userId", "productId");

-- AddForeignKey
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
