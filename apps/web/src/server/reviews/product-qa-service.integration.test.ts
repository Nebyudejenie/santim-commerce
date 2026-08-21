/**
 * Integration test — requires a real Postgres. The properties that matter
 * most: any signed-in user may ask (no proof-of-purchase gate, unlike
 * reviews), only the product's real seller may answer (a cross-seller
 * attempt is indistinguishable from not found, same discipline as every
 * other ownership-scoped mutation this session), and answering enqueues a
 * real outbox message for the customer notification.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { answerQuestion, askQuestion, listQuestionsForProduct, listUnansweredQuestionsForSeller, ProductQAError } from "./product-qa-service.ts";

const prisma = new PrismaClient();

async function makeSellerWithProduct(suffix: string) {
  const owner = await prisma.user.create({ data: { email: `qa-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `QA Test Seller ${suffix}`, slug: `qa-test-seller-${suffix}`, status: "APPROVED" },
  });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `qa-test-${suffix}`, title: "QA Test Item", description: "d", status: "ACTIVE" },
  });
  return { sellerId: seller.id, productId: product.id };
}

async function makeBuyer(suffix: string) {
  const user = await prisma.user.create({ data: { email: `qa-buyer-${suffix}@example.et`, role: "CUSTOMER" } });
  return user.id;
}

test("asking a question requires no proof of purchase — any signed-in user may ask", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { productId } = await makeSellerWithProduct(suffix);
  const buyerId = await makeBuyer(suffix);

  await askQuestion(buyerId, productId, "Does this run true to size?");

  const questions = await listQuestionsForProduct(productId);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.question, "Does this run true to size?");
  assert.equal(questions[0]!.answer, null);
});

test("a question under 5 characters is rejected, and nothing is persisted", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { productId } = await makeSellerWithProduct(suffix);
  const buyerId = await makeBuyer(suffix);

  await assert.rejects(
    () => askQuestion(buyerId, productId, "hi"),
    (err: unknown) => err instanceof ProductQAError && /at least 5/.test(err.message),
  );

  const questions = await listQuestionsForProduct(productId);
  assert.equal(questions.length, 0);
});

test("only the product's real seller can answer — a cross-seller attempt is indistinguishable from not found", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId: realSeller, productId } = await makeSellerWithProduct(suffix);
  const { sellerId: strangerSeller } = await makeSellerWithProduct(`${suffix}-stranger`);
  const buyerId = await makeBuyer(suffix);

  await askQuestion(buyerId, productId, "Is this available in blue?");
  const [question] = await listQuestionsForProduct(productId);

  await assert.rejects(
    () => answerQuestion(strangerSeller, question!.id, "Yes it is!"),
    (err: unknown) => err instanceof ProductQAError && /not found/.test(err.message),
  );
  const untouched = await prisma.productQuestion.findUniqueOrThrow({ where: { id: question!.id } });
  assert.equal(untouched.answer, null, "a cross-seller attempt must not have changed anything");

  await answerQuestion(realSeller, question!.id, "Yes it is!");
  const answered = await prisma.productQuestion.findUniqueOrThrow({ where: { id: question!.id } });
  assert.equal(answered.answer, "Yes it is!");
  assert.ok(answered.answeredAt);
  assert.equal(answered.answeredBySellerId, realSeller);
});

test("answering enqueues a real outbox message for the customer notification", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, productId } = await makeSellerWithProduct(suffix);
  const buyerId = await makeBuyer(suffix);

  await askQuestion(buyerId, productId, "How heavy is this item?");
  const [question] = await listQuestionsForProduct(productId);

  await answerQuestion(sellerId, question!.id, "About 400 grams.");

  const messages = await prisma.outboxMessage.findMany({ where: { topic: "question.answered" } });
  const forThisQuestion = messages.filter((m) => (m.payload as { questionId: string }).questionId === question!.id);
  assert.equal(forThisQuestion.length, 1, "answering must enqueue exactly one question.answered message");
});

test("listUnansweredQuestionsForSeller returns only that seller's own unanswered questions", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, productId } = await makeSellerWithProduct(suffix);
  const { sellerId: otherSeller, productId: otherProductId } = await makeSellerWithProduct(`${suffix}-other`);
  const buyerId = await makeBuyer(suffix);

  await askQuestion(buyerId, productId, "Unanswered question for real seller.");
  await askQuestion(buyerId, productId, "This one will be answered.");
  await askQuestion(buyerId, otherProductId, "A question for a completely different seller.");

  const mine = await listQuestionsForProduct(productId);
  const toAnswer = mine.find((q) => q.question === "This one will be answered.")!;
  await answerQuestion(sellerId, toAnswer.id, "Here is your answer.");

  const unanswered = await listUnansweredQuestionsForSeller(sellerId);
  assert.equal(unanswered.length, 1, "only the real unanswered question for THIS seller, not the answered one or the other seller's");
  assert.equal(unanswered[0]!.question, "Unanswered question for real seller.");

  const otherUnanswered = await listUnansweredQuestionsForSeller(otherSeller);
  assert.equal(otherUnanswered.length, 1);
  assert.equal(otherUnanswered[0]!.question, "A question for a completely different seller.");
});

test.after(async () => {
  await prisma.outboxMessage.deleteMany({ where: { topic: "question.answered" } });
  await prisma.productQuestion.deleteMany({ where: { product: { slug: { startsWith: "qa-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "qa-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "qa-test-seller-" } } });
  await prisma.user.deleteMany({
    where: { OR: [{ email: { startsWith: "qa-seller-" } }, { email: { startsWith: "qa-buyer-" } }] },
  });
  await prisma.$disconnect();
});
