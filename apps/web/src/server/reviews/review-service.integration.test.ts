/**
 * Integration test — requires a real Postgres. The property that matters
 * most here is verified-purchase enforcement: a user who never bought the
 * product must be rejected, not just cosmetically un-badged — the master
 * mandate's own framing of this as an abuse vector, not a nice-to-have.
 * Same authorization-testing discipline as every other feature this
 * session: adversarial cases get their own dedicated tests, not just
 * happy-path coverage.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  createReview,
  getProductRating,
  getSellerRating,
  hideReview,
  reportReview,
  respondToReview,
  ReviewError,
} from "./review-service.ts";

const prisma = new PrismaClient();

async function makeSellerWithProduct(suffix: string) {
  const owner = await prisma.user.create({ data: { email: `review-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Review Test Seller ${suffix}`, slug: `review-test-seller-${suffix}`, status: "APPROVED" },
  });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `review-test-product-${suffix}`, title: "Review Test Product", description: "d", status: "ACTIVE" },
  });
  return { sellerId: seller.id, productId: product.id };
}

async function makeBuyer(suffix: string) {
  const user = await prisma.user.create({ data: { email: `review-buyer-${suffix}@example.et`, role: "CUSTOMER" } });
  return user.id;
}

async function makePaidOrderFor(userId: string, productId: string, suffix: string) {
  const variant = await prisma.variant.create({
    data: { productId, sku: `RV-${suffix}`, title: "Default", priceSantim: 1000 },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-REVIEW${suffix}`.toUpperCase(),
      userId,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 1000,
      totalSantim: 1000,
      paidAt: new Date(),
      lines: {
        create: [
          {
            variantId: variant.id,
            sellerId: (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).sellerId,
            sku: `RV-${suffix}`,
            productTitle: "Review Test Product",
            variantTitle: "Default",
            unitPriceSantim: 1000,
            quantity: 1,
            lineTotalSantim: 1000,
          },
        ],
      },
    },
  });
  return order.id;
}

test("a user who never bought the product CANNOT review it", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { productId } = await makeSellerWithProduct(suffix);
  const userId = await makeBuyer(suffix);

  await assert.rejects(
    () => createReview({ userId, productId, rating: 5, body: "Never actually bought this." }),
    (err: unknown) => err instanceof ReviewError && /completed order/.test(err.message),
  );

  const count = await prisma.productReview.count({ where: { productId, userId } });
  assert.equal(count, 0);
});

test("a real buyer CAN review their purchased product, exactly once", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { productId } = await makeSellerWithProduct(suffix);
  const userId = await makeBuyer(suffix);
  await makePaidOrderFor(userId, productId, suffix);

  const review = await createReview({ userId, productId, rating: 4, title: "Pretty good", body: "Real, honest review text." });
  assert.equal(review.rating, 4);
  assert.equal(review.status, "PUBLISHED");

  await assert.rejects(
    () => createReview({ userId, productId, rating: 5, body: "Trying to review a second time." }),
    (err: unknown) => err instanceof ReviewError && /already reviewed/.test(err.message),
  );

  const count = await prisma.productReview.count({ where: { productId, userId } });
  assert.equal(count, 1, "exactly one review, the duplicate attempt must not have created a second row");
});

test("an unpaid (PENDING_PAYMENT) order does not grant review eligibility", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { productId } = await makeSellerWithProduct(`unpaid-${suffix}`);
  const userId = await makeBuyer(`unpaid-${suffix}`);

  const variant = await prisma.variant.create({ data: { productId, sku: `RVU-${suffix}`, title: "Default", priceSantim: 1000 } });
  await prisma.order.create({
    data: {
      orderNumber: `SC-REVIEWUNPAID${suffix}`.toUpperCase(),
      userId,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PENDING_PAYMENT",
      subtotalSantim: 1000,
      totalSantim: 1000,
      lines: {
        create: [
          {
            variantId: variant.id,
            sellerId: (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).sellerId,
            sku: `RVU-${suffix}`,
            productTitle: "x",
            variantTitle: "Default",
            unitPriceSantim: 1000,
            quantity: 1,
            lineTotalSantim: 1000,
          },
        ],
      },
    },
  });

  await assert.rejects(() => createReview({ userId, productId, rating: 5, body: "Should not be allowed yet." }), ReviewError);
});

test("rating aggregation: average and count are computed correctly across multiple reviewers", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { productId, sellerId } = await makeSellerWithProduct(`agg-${suffix}`);

  const ratings = [5, 3, 4];
  for (const [i, rating] of ratings.entries()) {
    const userId = await makeBuyer(`agg-${suffix}-${i}`);
    await makePaidOrderFor(userId, productId, `agg-${suffix}-${i}`);
    await createReview({ userId, productId, rating, body: `Review number ${i}, real text.` });
  }

  const productRating = await getProductRating(productId);
  assert.equal(productRating.count, 3);
  assert.equal(productRating.average, 4); // (5+3+4)/3 = 4

  const sellerRating = await getSellerRating(sellerId);
  assert.equal(sellerRating.count, 3);
  assert.equal(sellerRating.average, 4);
});

test("hiding a review excludes it from rating aggregation", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { productId } = await makeSellerWithProduct(`hide-${suffix}`);
  const userId = await makeBuyer(`hide-${suffix}`);
  await makePaidOrderFor(userId, productId, `hide-${suffix}`);
  const review = await createReview({ userId, productId, rating: 1, body: "A one-star review, real text." });

  const admin = await prisma.user.create({ data: { email: `review-admin-${suffix}@example.et`, role: "ADMIN" } });
  await hideReview(review.id, admin.id);

  const rating = await getProductRating(productId);
  assert.equal(rating.count, 0, "a HIDDEN review must not count toward the published aggregate");
});

test("a seller CANNOT respond to a review on another seller's product", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { productId } = await makeSellerWithProduct(`resp-owner-${suffix}`);
  const { sellerId: strangerSellerId } = await makeSellerWithProduct(`resp-stranger-${suffix}`);
  const userId = await makeBuyer(`resp-${suffix}`);
  await makePaidOrderFor(userId, productId, `resp-${suffix}`);
  const review = await createReview({ userId, productId, rating: 5, body: "Great product, real text." });

  await assert.rejects(() => respondToReview(strangerSellerId, review.id, "Not my product to respond to."), ReviewError);

  const untouched = await prisma.productReview.findUniqueOrThrow({ where: { id: review.id } });
  assert.equal(untouched.sellerResponse, null);
});

test("reporting the same review twice by the same user is rejected, not a duplicate report", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { productId } = await makeSellerWithProduct(`report-${suffix}`);
  const userId = await makeBuyer(`report-${suffix}`);
  await makePaidOrderFor(userId, productId, `report-${suffix}`);
  const review = await createReview({ userId, productId, rating: 2, body: "Fine, but reported anyway, real text." });

  const reporter = await makeBuyer(`reporter-${suffix}`);
  await reportReview(review.id, reporter, "Spam or fake");
  await assert.rejects(() => reportReview(review.id, reporter, "Reporting again"), ReviewError);

  const reportCount = await prisma.reviewReport.count({ where: { reviewId: review.id } });
  assert.equal(reportCount, 1);
});

test.after(async () => {
  await prisma.reviewReport.deleteMany({ where: { review: { product: { slug: { startsWith: "review-test-product-" } } } } });
  await prisma.productReview.deleteMany({ where: { product: { slug: { startsWith: "review-test-product-" } } } });
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-REVIEW" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-REVIEW" } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "review-test-product-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "review-test-product-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "review-test-seller-" } } });
  await prisma.user.deleteMany({
    where: {
      OR: [
        { email: { startsWith: "review-seller-" } },
        { email: { startsWith: "review-buyer-" } },
        { email: { startsWith: "review-admin-" } },
        { email: { startsWith: "reporter-" } },
      ],
    },
  });
  await prisma.$disconnect();
});
