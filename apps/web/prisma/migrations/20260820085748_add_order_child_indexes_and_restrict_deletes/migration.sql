-- DropForeignKey
ALTER TABLE "order_events" DROP CONSTRAINT "order_events_orderId_fkey";

-- DropForeignKey
ALTER TABLE "order_lines" DROP CONSTRAINT "order_lines_orderId_fkey";

-- DropForeignKey
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_orderId_fkey";

-- DropForeignKey
ALTER TABLE "shipping_labels" DROP CONSTRAINT "shipping_labels_orderId_fkey";

-- CreateIndex
CREATE INDEX "inventory_reservations_orderId_status_idx" ON "inventory_reservations"("orderId", "status");

-- CreateIndex
CREATE INDEX "orders_status_paidAt_idx" ON "orders"("status", "paidAt");

-- CreateIndex
CREATE INDEX "payment_intents_status_createdAt_idx" ON "payment_intents"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
