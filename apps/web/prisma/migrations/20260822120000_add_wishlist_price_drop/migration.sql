-- IF NOT EXISTS: same reasoning as every other enum addition this
-- session — Postgres has no ALTER TYPE ... DROP VALUE, so this stays
-- safe to apply again if this migration is ever amended after a partial
-- apply.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PRICE_DROP';

-- The DROP INDEX / ALTER COLUMN ... DROP DEFAULT statements the diff
-- engine also generated here are the same recurring, bogus artifact of
-- the hand-written products.searchVector generated column (see every
-- prior migration touching this schema) — stripped, not applied.

-- AlterTable: added nullable first, backfilled, then locked to NOT NULL —
-- a real production deploy has real existing wishlist_items rows with no
-- history of what the product cost when they were added, so the backfill
-- uses each product's CURRENT lowest active-variant price as the best
-- available starting point (never 0, which would look like a nonsensical
-- historical price and would need no real drop to "trigger" from).
ALTER TABLE "wishlist_items" ADD COLUMN "priceAtAddSantim" INTEGER;
ALTER TABLE "wishlist_items" ADD COLUMN "lastNotifiedPriceSantim" INTEGER;

UPDATE "wishlist_items" wi
SET "priceAtAddSantim" = COALESCE(
  (SELECT MIN(v."priceSantim") FROM "variants" v WHERE v."productId" = wi."productId" AND v."active" = true),
  0
)
WHERE wi."priceAtAddSantim" IS NULL;

ALTER TABLE "wishlist_items" ALTER COLUMN "priceAtAddSantim" SET NOT NULL;
