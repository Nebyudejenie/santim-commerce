-- IF NOT EXISTS: same reasoning as every other enum addition this
-- session — Postgres has no ALTER TYPE ... DROP VALUE, so this stays
-- safe to apply again if this migration is ever amended after a partial
-- apply.
ALTER TYPE "ReturnRequestStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';

-- The DROP INDEX / ALTER COLUMN ... DROP DEFAULT statements the diff
-- engine also generated here are the same recurring, bogus artifact of
-- the hand-written products.searchVector generated column (see every
-- prior migration touching this schema) — stripped, not applied.

-- AlterTable
ALTER TABLE "return_requests" ADD COLUMN     "disputeReason" TEXT,
ADD COLUMN     "disputedAt" TIMESTAMP(3);
