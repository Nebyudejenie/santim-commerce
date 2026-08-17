-- CreateEnum
CREATE TYPE "ShippingLabelStatus" AS ENUM ('PENDING', 'GENERATED', 'FAILED');

-- CreateTable
CREATE TABLE "shipping_labels" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ShippingLabelStatus" NOT NULL DEFAULT 'PENDING',
    "carrierLabelId" TEXT,
    "trackingNumber" TEXT,
    "labelUrl" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "shipping_labels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipping_labels_orderId_key" ON "shipping_labels"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_labels_idempotencyKey_key" ON "shipping_labels"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
