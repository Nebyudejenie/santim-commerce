-- IF NOT EXISTS: same reasoning as every other enum addition this
-- session — Postgres has no ALTER TYPE ... DROP VALUE, so this stays
-- safe to apply again if this migration is ever amended after a partial
-- apply.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'NEW_MESSAGE';

-- The DROP INDEX / ALTER COLUMN ... DROP DEFAULT statements the diff
-- engine also generated here are the same recurring, bogus artifact of
-- the hand-written products.searchVector generated column (see every
-- prior migration touching this schema) — stripped, not applied.

-- CreateTable
CREATE TABLE "message_threads" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "buyerUserId" TEXT NOT NULL,
    "buyerLastReadAt" TIMESTAMP(3),
    "sellerLastReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_threads_buyerUserId_idx" ON "message_threads"("buyerUserId");

-- CreateIndex
CREATE INDEX "message_threads_sellerId_idx" ON "message_threads"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "message_threads_orderId_sellerId_key" ON "message_threads"("orderId", "sellerId");

-- CreateIndex
CREATE INDEX "messages_threadId_createdAt_idx" ON "messages"("threadId", "createdAt");

-- AddForeignKey
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_buyerUserId_fkey" FOREIGN KEY ("buyerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "message_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
