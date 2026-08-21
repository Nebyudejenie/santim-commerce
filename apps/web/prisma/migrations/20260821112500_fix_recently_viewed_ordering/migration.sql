-- Fixes a real ordering bug: the previous "order by viewedAt desc, id desc"
-- scheme is wrong once a row is UPDATED (re-viewed) rather than created —
-- an upsert's update branch never changes `id`, so an older row that gets
-- re-viewed now can still lose a viewedAt tie against a newer, untouched
-- row. This sequence is bumped via nextval() on every view, create or
-- update, in recordView — see recently-viewed-service.ts and
-- schema.prisma's own comment on RecentlyViewed.touchSeq.

-- CreateSequence
CREATE SEQUENCE "recently_viewed_touch_seq";

-- AlterTable
ALTER TABLE "recently_viewed" ADD COLUMN     "touchSeq" BIGINT NOT NULL DEFAULT 0;

-- DropIndex
DROP INDEX "recently_viewed_userId_viewedAt_idx";

-- CreateIndex
CREATE INDEX "recently_viewed_userId_touchSeq_idx" ON "recently_viewed"("userId", "touchSeq");
