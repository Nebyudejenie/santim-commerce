-- Same reasoning as the BACK_IN_STOCK migration: IF NOT EXISTS since
-- Postgres has no ALTER TYPE ... DROP VALUE, so this stays safe to apply
-- again if this migration is ever amended after a partial apply.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LOW_STOCK';

-- AlterTable
ALTER TABLE "inventory" ADD COLUMN     "lowStockAlertedAt" TIMESTAMP(3),
ADD COLUMN     "lowStockAlertCount" INTEGER NOT NULL DEFAULT 0;
