-- AlterTable
ALTER TABLE "order_lines" ADD COLUMN     "fulfilledAt" TIMESTAMP(3),
ADD COLUMN     "fulfilmentStatus" "FulfilmentStatus" NOT NULL DEFAULT 'UNFULFILLED';
