-- The DROP INDEX / ALTER COLUMN ... DROP DEFAULT statements the diff
-- engine also generated here are the same recurring, bogus artifact of
-- the hand-written products.searchVector generated column (see every
-- prior migration touching this schema) — stripped, not applied.

-- AlterTable
ALTER TABLE "message_threads" ADD COLUMN     "hiddenAt" TIMESTAMP(3);
