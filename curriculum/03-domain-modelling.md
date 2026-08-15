# Phase 3 — Domain Modelling & the E-Commerce Core

*Same method as Phases 1 and 2: every claim is illustrated with a real file from `santim-commerce`.
Open the referenced file alongside this document.*

---

## Why this phase exists

Phases 1 and 2 made the *payment* correct. This phase makes everything **underneath** the payment
correct — because a flawless payment integration wrapped around a data model that oversells stock,
mangles a guest's cart, or lets a late catalogue-price update silently overcharge a customer is
still a broken store. The gate for this phase is a single sentence, and it's worth reading before
anything else: **200 concurrent buyers, 1 unit in stock, exactly one sells.** Everything below
either builds toward that guarantee or depends on it.

---

## 1. Product ≠ Variant — the distinction that separates a toy shop from a real one

`prisma/schema.prisma`'s own design-rules header states this as rule #2, ahead of almost
everything else in the file: *"PRODUCT ≠ VARIANT. Stock, price, and SKU live on the variant. This
is the single structural difference between a toy shop and a real one."*

A `Product` is a marketing concept — a title, a description, images, SEO fields. It is not
buyable. `Variant` is the thing a customer actually purchases:

```prisma
/// A buyable thing. Price and stock live HERE, not on Product.
model Variant {
  productId String
  ...
  sku       String  @unique
  title     String  // "Black / 42"
  /// Selected options as {"Colour":"Black","Size":"42"} — kept denormalised
  /// for display; the authoritative option data is in VariantOption.
  options   Json    @default("{}")

  /// Price in SANTIM. Never a Float.
  priceSantim        Int
  /// Original price for strike-through display, in santim.
  compareAtSantim    Int?
  /// What this unit cost us, for margin reporting.
  costSantim         Int?
  ...
  inventory    Inventory?
  ...
}
```

**Why this split matters in practice, not just in theory:** "T-Shirt" is not a SKU. "T-Shirt,
Black, size 42" is. A model that puts `priceSantim` and stock on `Product` directly can express
exactly one price and one stock count per product — which works fine for a demo with one size per
item, and breaks the instant a real merchant lists a shirt in four colours and six sizes, each
with its own price, its own barcode, its own stock count, and its own ability to sell out
independently of the others. Retrofitting variants onto a product-only schema after real orders
exist is a migration nobody enjoys; this codebase starts variant-first specifically so that
question never has to be asked twice.

`Variant.options` is deliberately **denormalised JSON** (`{"Colour":"Black","Size":"42"}`) kept
purely for display, with the comment noting authoritative option data belongs in a separate
structure if the catalogue ever needs to query "every variant with Size=42 across all products" —
a JSON blob can't be indexed usefully for that; a real `VariantOption` join table could. This
codebase doesn't need that query yet, so it doesn't have that table yet — a small, honest example
of not building normalization the current requirements don't ask for.

---

## 2. Inventory as three numbers, and the concurrency proof

Rule #3 in the schema header: *"INVENTORY IS THREE NUMBERS, not one: onHand, reserved, and the
derived available = onHand - reserved. Reservations expire."*

```prisma
model Inventory {
  variantId String  @id
  ...
  /// Physically in the warehouse.
  onHand    Int     @default(0)
  /// Held by in-flight checkouts. available = onHand - reserved.
  reserved  Int     @default(0)
  ...
}
```

A single `stock` number cannot distinguish "nobody's buying this" from "three people have it in
their cart right now, mid-checkout." Without that distinction, either you oversell (letting new
buyers see stock that's already spoken for) or you undersell (blocking purchases the moment
*anyone* starts checking out, even if their checkout later abandons). Three numbers, with
`available` always derived and never stored — the schema comment is explicit that a stored derived
value is a bug waiting for a race condition, because the moment two different code paths can write
to it independently, it can disagree with `onHand - reserved` after any missed update.

### 2.1 The race, and the fix that looks right but isn't

`reservation.ts`'s own module comment states the failure mode plainly, worth reading in full
because almost every first attempt at this problem makes exactly this mistake:

> Two customers open the product page for the last unit in stock within the same second. Both
> pass the "is it in stock?" check, because both check BEFORE either writes anything — the
> classic check-then-act race.
>
> ```ts
> const inv = await prisma.inventory.findUnique({ where: { variantId } });
> if (inv.onHand - inv.reserved >= qty) {
>   await prisma.inventory.update({ where: { variantId }, data: { reserved: { increment: qty } } });
> }
> ```
>
> The read and the write are two round-trips. Between them, another request can do the same read,
> see the same (still-available) numbers, and also proceed. Under load this is not a rare edge
> case — it is Tuesday.

The fix folds the check and the write into **one statement**, so Postgres's own row locking does
the serialising instead of application code trying to out-think the scheduler:

```sql
UPDATE "inventory"
   SET "reserved" = "reserved" + $quantity
 WHERE "variantId" = $variantId
   AND ("allowBackorder" = TRUE OR ("onHand" - "reserved") >= $quantity)
```

**Why this specifically works, mechanically:** Postgres takes a row lock for the duration of the
`UPDATE`. A second concurrent `UPDATE` against the *same row* queues behind it — and because this
runs under `READ COMMITTED` (Postgres's default isolation level), the queued statement
**re-evaluates its `WHERE` clause against the now-current row** once the lock releases, rather
than against the stale snapshot it started with. The second caller sees the first caller's
decrement already applied, and correctly fails the `>= $quantity` check. No amount of application-
level checking replicates this — it works because the database itself refuses to let the second
writer see stale data at the exact moment that would matter.

This is also *why* the query is raw SQL (`$executeRaw`) instead of Prisma's query builder: Prisma's
filter DSL cannot express a comparison between two columns of the same row
(`"onHand" - "reserved" >= $quantity`). Dropping to raw SQL here isn't a workaround — it's
recognizing a real expressiveness gap and reaching for the correct tool, with values still fully
parameterised (no SQL injection surface reopened by leaving the ORM).

**A detail worth pausing on, because it's easy to get backwards:** the columns are quoted,
camelCase, exact-case (`"onHand"`, `"reserved"`, `"variantId"`) — not `onhand`, `reserved`,
`variant_id`. Prisma does not snake_case column names by default, and this schema has no `@map`
on these fields. An *unquoted* identifier in Postgres is folded to lowercase automatically — so
`onHand` unquoted silently becomes `onhand`, which doesn't exist, and the query fails (or worse,
in a differently-cased schema, silently matches the wrong column). Quoting isn't stylistic here;
it's the difference between a query that works and one that fails in a way that has nothing to do
with your actual logic.

### 2.2 Multi-item checkouts and the deadlock nobody predicts on the first try

A single-item reservation is only half the problem. `reserveForOrder()` reserves *every line of an
order* atomically — and the moment more than one item is involved, a second, sneakier concurrency
bug appears: **deadlock.**

```ts
// reserveForOrder()
const sorted = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
```

The comment explains why sorting happens *before any write*:

> Two checkouts buying the same two items in opposite order (A-then-B vs B-then-A) can each hold
> one lock and wait on the other — a classic deadlock. A fixed acquisition order makes that
> structurally impossible: whichever request goes first always goes first for every item.

Picture it without the sort: Order X reserves item B, then reaches for item A. Order Y — checking
out at the same instant with the same two items in its cart, added in the opposite order —
reserves item A, then reaches for item B. X is now waiting on the lock Y holds; Y is waiting on the
lock X holds. Neither can proceed, and Postgres eventually kills one transaction with a `40P01`
deadlock error to break the tie. Sorting both requests' line items into the *same* order
(lexicographic by `variantId`) before acquiring anything means X and Y always reach for items in
the same sequence — one of them simply finishes acquiring first, the other queues normally behind
a single lock, and no cycle can ever form.

**This is proven, not just argued**, by
`reservation.integration.test.ts`'s `"deadlock-free acquisition: two orders buying the same two
items in opposite order"` — which deliberately constructs the exact scenario above (one order's
line list reversed relative to the other's) and asserts both complete without a deadlock error.
The test's own comment is honest about what failure would look like: not a clean "denied" result,
but an *unhandled rejection* — a `40P01` surfacing as a crash, which is precisely why this needed
a real concurrent test and not a code review to catch.

### 2.3 The full proof, worked through five real tests

`reservation.integration.test.ts` is the file this curriculum's own gate is built on. Five tests,
each isolating one failure mode:

| Test | Proves |
|---|---|
| 200 buyers, 1 unit in stock | Exactly 1 grant, 199 denials — `reserved` never exceeds `onHand` |
| 50 buyers, 10 units in stock | Exactly 10 grants — the pattern holds at any stock level, not just 1 |
| 3 units, one request for 5 | Denied *atomically* — `reserved` stays exactly 0, never a partial 3 |
| Backorder-enabled variant | `allowBackorder` correctly permits reserving past `onHand` |
| Two orders, same two items, opposite acquisition order | Both complete — no deadlock |

The module comment states plainly why none of these can be proven with a mocked Prisma client:
*"mocks do not have Postgres's row-locking behaviour, which is the entire mechanism the code
relies on. Only hitting a real database is evidence."* This is Phase 1 §9's "why mocks lie,"
concretely: a mock of `prisma.inventory.update` would happily let you write whatever assertion you
wanted, entirely independent of whether the actual SQL statement's concurrency behavior matches
reality. The three-quantity-denied-atomically test specifically would be *trivial* to fake with a
mock and *impossible* to fake against real Postgres — which is exactly the property that makes it
worth something.

---

## 3. Cart: guests are first-class, and price is snapshotted at add-time

`cart-service.ts` opens with two rules stated as consequences, not preferences:

> **GUESTS ARE FIRST-CLASS.** A cart is identified by an opaque, unguessable `token` stored in an
> httpOnly cookie — never by session or user id alone. Forcing login before "add to cart" is a
> proven conversion killer, and it also means the cart has to be re-architected the day someone
> asks for guest checkout. Design for it from the start.

```ts
export function generateCartToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}
```

24 random bytes — the token is a **bearer credential**, functionally equivalent to a session
token for the one resource it grants access to. It has to be unguessable for the same reason a
session cookie does: anyone holding the token can read and modify that cart.

### 3.1 Price snapshotting — and the honest UI it enables

> **PRICE IS SNAPSHOTTED AT ADD-TIME, RE-CHECKED AT CHECKOUT.** Storing only a `variantId` and
> reading the live price at render time means a mid-cart price change silently changes what the
> customer thought they agreed to pay.

`CartLine.unitPriceSantim` is set once, when the item is added, and never silently overwritten.
`priceCartLines()` is the pure function that compares it against the *current* live price on every
render:

```ts
export function priceCartLines(lines: readonly CartLineLike[]): PricedLine[] {
  return lines.map((line) => {
    const current = line.variant.priceSantim;
    return {
      variantId: line.variantId,
      quantity: line.quantity,
      snapshotPriceSantim: line.unitPriceSantim,
      currentPriceSantim: current,
      priceChanged: current !== line.unitPriceSantim,
      lineTotalSantim: current * line.quantity,
    };
  });
}
```

**The detail worth noticing:** `lineTotalSantim` here is computed from the **current** price, not
the snapshot — the cart page shows what you'd actually pay right now, with `priceChanged` as a
separate flag driving an honest "this went up since you added it" banner. The snapshot's job isn't
to freeze the displayed total; it's to *detect drift*, which `checkout-service.ts` then acts on —
see §4 below.

### 3.2 The merge that most cart implementations get wrong

`getOrCreateCart()` handles the simple case: a guest with no prior account history logs in, and
their guest cart is reassigned to their new `userId`. The harder, easy-to-miss case is a
**returning customer** — someone who already has their own persistent cart from a previous
session, now adding items as a guest before logging back in. `mergeGuestCartIntoUser()`'s own
comment explains why the simple reassignment isn't enough there:

> Blindly reassigning the current guest cart's `userId` in that case would leave the user with
> two active carts, one of them orphaned and invisible to them.

The merge itself sums quantities rather than picking a "winner," and the reasoning is stated
directly:

> Line quantities ADD (not replace) on overlap — the guest added 2 of a shirt just now, their
> saved cart already had 1, they see 3. Reducing to whichever cart "wins" would silently drop
> items the customer put there on purpose in the other session.

```ts
await tx.cartLine.upsert({
  where: { cartId_variantId: { cartId: existingUserCart.id, variantId: line.variantId } },
  create: {
    cartId: existingUserCart.id,
    variantId: line.variantId,
    quantity: line.quantity,
    unitPriceSantim: line.unitPriceSantim,
  },
  update: { quantity: { increment: line.quantity } },
});
```

The abandoned guest cart is marked `ABANDONED`, never deleted — "preserved for order history /
analytics continuity, the same reasoning `WebhookEvent` rows are never deleted after processing"
(the comment draws this parallel explicitly). **The generalizable rule:** a row that was once true
is historical evidence, not garbage — delete only what genuinely never needs to be reconstructed
or audited later, and default to soft-deletion (a status flag) for everything else.

---

## 4. Checkout: the moment a cart becomes an order

`checkout-service.ts`'s module comment lays out a six-step sequence and calls it "deliberately
rigid" — worth reading as a single unit, because the ORDER of these steps is the entire design:

> 1. Re-price the cart against LIVE variant prices — never trust the snapshot.
> 2. Reserve inventory for every line, ATOMICALLY, inside the same transaction that creates the
>    order. All lines succeed or none do.
> 3. Create the Order + OrderLines with prices snapshotted onto them — **permanently**, this time.
> 4. Mark the cart CONVERTED.
> 5. COMMIT.
> 6. Only after the commit, start the SantimPay payment — **outside** the transaction.

### 4.1 Why step 6 is outside the transaction — tying directly back to Phase 1 §4

An external HTTP call has no place inside a database transaction: it would hold Postgres locks for
the duration of a network round trip to a third party, which under any real load turns "a slow
gateway response" into "every other checkout touching the same rows queues behind this one open
transaction." This is Phase 1 §4's dual-write problem again, and the same resolution: order the
writes so the unsafe half (the network call) happens *after* the safe half (the database commit)
is durable. If step 6 fails, the order already exists, `PENDING_PAYMENT`, with its stock reserved
— `startPayment()`'s reuse-in-flight-intent logic (Phase 2 §3) picks it back up on retry rather
than double-booking anything.

### 4.2 `PriceChangedError` — refusing to guess what the customer meant

Step 1's re-pricing check has a real consequence if it finds drift:

```ts
const priced = priceCartLines(cart.lines as unknown as CartLineLike[]);
const changed = priced.filter((l) => l.priceChanged);
if (changed.length > 0 && !input.acceptPriceChanges) {
  throw new PriceChangedError(changed.map((l) => l.variantId));
}
```

Checkout does not silently charge the new (higher, usually) price, and it does not silently keep
charging the stale snapshot either — both are a customer being charged something they didn't
knowingly agree to. It throws a specific, typed error the UI catches, shows the new prices, and
requires an **explicit** `acceptPriceChanges: true` on retry before checkout proceeds. The
customer sees the real number before money moves, every time a mid-cart price change is caught —
never after.

### 4.3 Reservation lives inside the order-creation transaction — not beside it

```ts
const order = await prisma.$transaction(async (tx) => {
  const created = await tx.order.create({ data: { /* orderNumber, totals, lines: { create: ... } */ } });

  // Reservation happens INSIDE this transaction. If any line is out of
  // stock, `reserveForOrder` throws, the whole transaction — order,
  // lines, and any partial reservations — rolls back atomically. No
  // "order created but nothing reserved" state can ever be observed.
  await reserveForOrder(tx, created.id, reserveLines, expiresAt);

  await tx.cart.update({ where: { id: cart.id }, data: { status: "CONVERTED" } });

  await tx.orderEvent.create({ data: { /* orderId, type: "order.placed", ... */ } });

  return created;
});
```

**The state that must never be observable, and how this prevents it:** an `Order` row existing
with *no* corresponding stock held for it. If `reserveForOrder` were called in a *separate*
transaction after the order commits, a crash between the two would leave exactly that — a real
order, no reservation, silently oversellable stock. Folding both into one transaction means the
only two outcomes are "order exists and stock is held" or "neither exists" — nothing in between is
reachable, by construction, not by discipline.

---

## 5. Pricing: order of application, and the questions this codebase deliberately leaves open

`checkout-service.ts` computes the total in one explicit sequence:

```ts
const subtotalSantim = cartSubtotalSantim(priced);
const taxSantim = calculateTax(santim(subtotalSantim));
const shippingSantim = calculateShipping(input.shippingZone, santim(subtotalSantim));
const totalSantim = subtotalSantim + shippingSantim + taxSantim;
```

### 5.1 Tax — one rate, applied on top, and an explicit list of what's out of scope

`tax-service.ts` computes Ethiopian VAT (15%, under VAT Proclamation No. 285/2002) as an
**addition on top of** the subtotal — not backed out of a tax-inclusive shelf price — using the
exact same `applyRate(..., "half-up")` from Phase 2 §1, so every rate calculation in the codebase
rounds the same way and agrees with finance by construction, not by coincidence.

More instructive than the calculation itself is the module's own list of what it deliberately does
**not** handle yet, and where the seam is for each:

> - Zero-rated / exempt goods — add a `taxCategory` to `Variant` and branch on it here; do not
>   special-case product slugs inline.
> - Tax-inclusive pricing display — switching is a pricing-model decision, not a one-line change.
> - Multi-jurisdiction tax — if that ever changes, this is the one file that needs to grow a
>   jurisdiction parameter; nothing else in `checkout-service.ts` should need to know.

**This is the anti-corruption layer idea from Phase 1 §6, pointed inward instead of at a vendor:**
every other file in the checkout path calls `calculateTax(subtotal)` and gets a number back. None
of them know or care whether that number came from one flat rate, a category lookup, or a
jurisdiction table — which is exactly what makes the *future* version of this file able to grow
without touching `checkout-service.ts` at all.

`checkout-service.ts` itself flags the one real open question inline, rather than silently
assuming an answer: *"Whether Ethiopian VAT also applies to the shipping charge itself is a real
question for an accountant, not something to assume silently... get that confirmed before this
figure is load-bearing for a real tax filing."* Notice what this comment is: an engineer correctly
identifying the limit of what engineering alone can answer, and saying so directly in the code
instead of picking an answer and hiding the uncertainty.

### 5.2 Shipping — zones over false precision

`shipping-service.ts` explains its own design choice (flat-rate zones, not a carrier API or a
city/woreda lookup table) as a deliberate match to how the model actually works in this market:

> There is no dominant integrated carrier API for Ethiopian last-mile delivery the way there's a
> FedEx/USPS rate API to plug into elsewhere... A full city/woreda-level rate table would be
> false precision for a rate structure that's genuinely two-tier in practice.

And a specific, concrete reason the customer picks an explicit zone rather than the system
inferring it from a free-text city field: *"'Addis Ababa', 'addis', 'A.A', 'አዲስ አበባ' are all the
same zone to a human and none of them safely to a string-match."* **The generalizable lesson:**
matching your data model's precision to your actual business rules — not to how precise a spec
sheet *could* theoretically be — is itself a design decision, and the wrong direction to err in
commerce is usually toward inferring structure from free text a human typed.

---

## 6. Order lifecycle: a second state machine, sitting beside the payment one

Phase 2 covered `PAYMENT_TRANSITIONS` in depth. `state-machine.ts` defines a **second**, related
but distinct table for the order itself:

```ts
const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ["PAID", "FAILED", "CANCELLED"],
  PAID:            ["REFUNDED", "PARTIALLY_REFUNDED", "CANCELLED"],
  FAILED:          ["PENDING_PAYMENT", "CANCELLED"], // customer may retry with another channel
  CANCELLED:       [],
  PARTIALLY_REFUNDED: ["REFUNDED"],
  REFUNDED:        [],
};
```

**Two transitions worth specifically noticing, because both encode a real business decision, not
just a technical constraint** — the same kind of "which impossible transition would actually cause
harm" reasoning Phase 1 §5 applied to `EXPIRED → COMPLETED` on the payment side:

- `FAILED → PENDING_PAYMENT`: a failed payment is not the end of the order. `payment-service.ts`'s
  own comment notes a customer whose Telebirr attempt fails may retry with CBE Birr — a second
  `PaymentIntent` against the *same* order (which is exactly why payment state lives on
  `PaymentIntent`, never on `Order`, per the schema comment on that model — an order can have
  several attempts).
- `PAID → PARTIALLY_REFUNDED`: fulfilment and refunds aren't all-or-nothing. `FulfilmentStatus`
  (`UNFULFILLED → PARTIALLY_FULFILLED → FULFILLED`) tracks shipping progress independently of
  payment status — an order can be fully `PAID` while only some of its lines have shipped, which
  is why fulfilment gets its own enum on `Order` rather than being folded into `OrderStatus`
  itself.

### 6.1 A small, honest engineering detail worth knowing about

`IllegalTransitionError`'s constructor is written out longhand instead of using TypeScript's
parameter-property shorthand (`constructor(readonly from: string)`), and the comment says exactly
why:

> Parameter properties EMIT code, so they cannot be erased — which means Node's built-in
> type-stripping refuses the file, and this module has to run unbuilt in tests and in the worker.
> A small syntax cost for zero build tooling.

This ties directly to a constraint from earlier in this codebase's build (the `node
--experimental-strip-types` limitation the worker and tests rely on): TypeScript syntax that is
*purely type-level* — annotations, interfaces — can be stripped by deleting text, no compilation
needed. Parameter properties are not purely type-level; they're sugar that *generates* real
`this.from = from` assignments the stripper has no way to synthesize. **The lesson:** "this
TypeScript feature is convenient" and "this TypeScript feature is compatible with your specific
runtime strategy" are different questions, and the second one doesn't get easier to answer by
ignoring it until a file mysteriously fails to run unbuilt.

### 6.2 Order numbers are a UX detail with real correctness content

`order-number.ts` generates a customer-facing identifier distinct from the database primary key,
and the alphabet choice is not arbitrary:

```ts
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32, no I L O U
```

I, L, O, and U are excluded because they're the characters most often confused with 1, 1, 0, and V
— when read aloud over the phone to a support agent, or misheard on a bad mobile connection. A
`cuid()` primary key is fine for a URL; it is not fine for "can you read me your order number" —
and `generateUniqueOrderNumber()` still retries against the actual database unique constraint on
collision rather than trusting the (astronomically large) keyspace, because, as the comment puts
it, "a payments system does not get to shrug at 'astronomically unlikely.'"

---

## 7. Postgres in depth

### 7.1 Isolation levels — why `READ COMMITTED` (the default) is enough here, and when it wouldn't be

Every example in §2 relies on Postgres's **default** isolation level, `READ COMMITTED`, without
this codebase ever setting it explicitly. Two other levels exist and are worth knowing, precisely
because knowing when you *don't* need them is as valuable as knowing how to use them:

| Level | Guarantees | This codebase |
|---|---|---|
| **READ COMMITTED** (default) | Each statement sees data as of when *that statement* began; a statement that blocks on a lock re-reads current data once unblocked | Used everywhere — the atomic `UPDATE`'s WHERE-clause re-evaluation on lock release (§2.1) depends on exactly this behavior |
| **REPEATABLE READ** | The whole *transaction* sees one consistent snapshot from when it began, even across multiple statements | Not used — would actually **break** the reservation pattern: a blocked UPDATE waiting under REPEATABLE READ raises a serialization error on conflict rather than re-reading current data, which this codebase would then have to catch and retry manually |
| **SERIALIZABLE** | Transactions behave as if run one at a time, in some order | Not used — strongest guarantee, but real throughput cost; appropriate when correctness requires reasoning across *multiple* tables' worth of invariants simultaneously, which single-row atomic updates don't need |

**The rule to take away:** picking an isolation level is picking a tradeoff between correctness
guarantees and both throughput and implementation complexity (SERIALIZABLE and REPEATABLE READ
both require your application to handle serialization-failure retries, which READ COMMITTED's
"just re-reads current data" behavior doesn't). This codebase's inventory logic is specifically
*designed to lean on* READ COMMITTED's re-read behavior rather than fight it — the atomic UPDATE
pattern from §2.1 wouldn't need to exist in its current form under REPEATABLE READ, but a
different, retry-loop-shaped pattern would.

### 7.2 Indexes — reading them as a claim about real query patterns

Every `@@index` in the schema is a specific answer to "what will this table actually be queried
by," not a defensive "index everything" reflex. A few worth reading as intentional:

Three real declarations, pulled from three different models in the schema (none of the source's
own lines carry comments — the annotations below are this document's, matched to what actually
queries each one):

```prisma
model Order {
  @@index([status, placedAt])   // Order.status, Order.placedAt
  @@index([userId, placedAt])
  @@index([email])
}
```
— the admin order list (filtered by status, sorted by date), the "my orders" page, and guest
order lookup by email, respectively.

```prisma
model PaymentIntent {
  @@index([status, nextPollAt])
}
```
— matches the worker's `settleDuePayments()` query exactly (below).

```prisma
model InventoryReservation {
  @@index([status, expiresAt])
}
```
— matches `expireReservations()`'s query the same way.

`PaymentIntent`'s `[status, nextPollAt]` index isn't a guess — it exists because
`worker/index.ts`'s `settleDuePayments()` runs *exactly* this query every 5 seconds:

```ts
const due = await prisma.paymentIntent.findMany({
  where: {
    status: { in: ["CREATED", "PENDING"] },
    nextPollAt: { lte: new Date() },
  },
  orderBy: { nextPollAt: "asc" },
  take: BATCH,
});
```

Without a matching index, that query forces a sequential scan of the entire `payment_intents`
table on every tick, forever, getting slower as the table grows — exactly the kind of thing that
works fine in development against a few hundred rows and becomes a real production problem at
scale, silently, because nothing *errors*, it just gets gradually slower. **The habit worth
building:** every time you write a `WHERE` clause that will run repeatedly (a worker loop, a
frequently-hit endpoint), go look at whether an index actually matches it — don't assume one does
because *some* index exists on that table.

### 7.3 What this codebase does not use, and why that's worth knowing rather than assuming

**Advisory locks** (`pg_advisory_lock` and friends — application-defined locks keyed by an
arbitrary integer, not tied to any specific row) are not used anywhere in this codebase. They
solve a different problem than the row-level locking in §2: an advisory lock is for serializing
access to something that *isn't* naturally a database row — "only one instance of this cron job
should run at a time," say. This codebase's concurrency problems (inventory, payment settlement)
are all naturally row-scoped, so a real row lock (via the atomic `UPDATE`) is the more precise
tool — an advisory lock here would serialize *more* than necessary, since it has no natural
connection to which specific variant is being reserved.

**`EXPLAIN ANALYZE`** doesn't appear anywhere in this codebase's source, and that gap is itself
worth being honest about rather than silently filling with an authoritative-sounding paragraph:
there is no example in this project of diagnosing a slow query with it. That's exactly what Lab
3.5 below asks you to do for real, against this schema, rather than reading about it.

---

## 8. Audit trail, honestly distinguished from event sourcing

`OrderEvent`'s schema comment calls it *"append-only audit trail. When a customer asks 'what
happened to my order', this is the answer, and when an auditor asks, this is the evidence."* This
is real and valuable — but it is worth being precise about what it is **not**: this codebase does
**not** do event sourcing.

**The distinction, concretely:** in true event sourcing, `Order.status` would not be a column you
write directly — it would be *computed*, on read, by replaying every `OrderEvent` for that order
in sequence. Here, `Order.status` is written directly by `applyPaymentTransition()` (Phase 2 §3.2,
inside the same transaction as the `OrderEvent` insert), and `OrderEvent` rows are a **parallel,
append-only record of what happened**, not the source of truth `status` is derived from. If every
`OrderEvent` row vanished tomorrow, every order's current status would still be exactly correct —
you'd lose the *history* of how it got there, not the truth of where it is.

**Why that's the right call here, not a shortcut:** full event sourcing earns its complexity when
you need to reconstruct state *as of any arbitrary point in the past*, replay history through
changed business logic to see what a different rule would have produced, or rebuild a read model
from scratch after a bug in how it was projected. None of those needs exist yet in this codebase.
What *does* exist — "show me everything that happened to this order, in order, for support and
audit purposes" — is exactly what an append-only log gives you, at a fraction of the
implementation and operational complexity of making every piece of state a replay result. Reach
for full event sourcing when the *specific* capabilities above are a real requirement, not because
an audit trail and an event-sourced system both involve a table of things that happened.

---

## Labs

### Lab 3.1 — Reproduce the core proof yourself, then break it on purpose

Run `reservation.integration.test.ts` against a real Postgres (`docker compose up -d postgres`,
then `prisma migrate deploy`, then the test file directly — the file's own header has the exact
commands). All five tests should pass. Now comment out the `AND ("allowBackorder" = TRUE OR
("onHand" - "reserved") >= ${quantity})` clause from the raw SQL in `reservation.ts`, leaving the
`UPDATE` unconditional, and re-run just the "200 concurrent buyers" test. Watch `reserved` end up
far past `onHand`. Put the clause back, confirm green again. The point isn't the bug — it's feeling
concretely how thin the line is between "atomic and correct" and "silently unconditional."

### Lab 3.2 — Reproduce the deadlock without the fix

Temporarily remove the `sort()` call at the top of `reserveForOrder()` so lines are reserved in
whatever order the caller happened to pass them. Re-run the "two orders, same two items, opposite
order" test in a loop (a single run may not always land inside the exact race window). Confirm you
can observe a `40P01` deadlock error — Postgres detecting the cycle and killing one of the two
transactions to break it — surfacing as the *unhandled rejection* the test's own comment warns
about, not a clean assertion failure. Restore the sort; confirm the test passes reliably across
many repeated runs, not just once.

### Lab 3.3 — Guest cart merge, the case that's easy to miss

Create a cart as a guest (no login), add two items. Separately, create a real user account, log
in, add a *different* item to the cart while authenticated — this is now that user's persistent
cart. Log out. As a guest again (same browser, same guest cart token from step one, still active),
add a third item. Now log back in as the same user. Confirm: all three items are present in the
resulting cart, with quantities correctly summed on any overlapping variant, and the leftover
guest cart row is marked `ABANDONED`, not deleted. This is `mergeGuestCartIntoUser()`'s harder
branch (§3.2) — the one a simpler "just reassign userId" implementation gets wrong.

### Lab 3.4 — Price drift at checkout

Add an item to a cart. Directly update that variant's `priceSantim` in the database (simulating a
merchandiser changing a price mid-shopping-session). Attempt checkout. Confirm `PriceChangedError`
is thrown and the order is **not** created. Retry with `acceptPriceChanges: true`. Confirm the
order is created at the **new** price, and that `OrderLine.unitPriceSantim` matches the live price
at the moment of the second attempt, not the original cart snapshot.

### Lab 3.5 — `EXPLAIN ANALYZE`, for real, against this schema

Seed the `orders` table with a few hundred thousand synthetic rows (a script, not by hand). Run
`EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'PENDING_PAYMENT' ORDER BY "placedAt" DESC
LIMIT 50` with the `[status, placedAt]` index in place — note the plan (should be an index scan).
Then drop that index and run the identical query again — note the plan changes to a sequential
scan, and compare the actual execution time reported by `ANALYZE` between the two runs. This
codebase's source has no worked example of this technique (see §7.3) — this lab is that missing
example, against real data you generated, not a toy table.

---

## Gate — do not proceed to Phase 4 until you can do this cold

1. **Why does `Inventory.available` not exist as a stored column?** (A stored derived value is a
   bug waiting for a race condition — anything that can write it independently of `onHand` and
   `reserved` can make it disagree with them. Always compute it.)
2. **Explain, mechanically, why the atomic reservation `UPDATE` works under `READ COMMITTED` but
   would behave differently under `REPEATABLE READ`.** (READ COMMITTED re-reads current data when
   a blocked statement's lock releases; REPEATABLE READ would instead raise a serialization
   conflict the application would have to catch and retry.)
3. **What specific, real failure does sorting reservation lines by `variantId` prevent, and why
   does a fixed order prevent it structurally rather than just making it less likely?** (Deadlock
   from two transactions acquiring the same two row locks in opposite order; a fixed order means
   whichever transaction goes first for one lock goes first for *every* lock, so the circular
   wait-for cycle a deadlock requires can never form.)
4. **A cart's price snapshot disagrees with the live price at checkout. Name the two wrong ways to
   handle it and the one this codebase actually does.** (Wrong: silently charge the new price;
   wrong: silently honor the stale one. Right: refuse, tell the customer the real number, require
   explicit confirmation before proceeding.)
5. **`OrderEvent` looks like event sourcing. Say precisely why it isn't, in one sentence.** (Order
   status is written directly and is the source of truth; `OrderEvent` is a parallel audit record
   of what happened, not what the current state is derived from.)

---

*Next: `04-the-interface-layer.md` — Phase 4: Server Components, Server Actions, and why the wire
protocol between a browser and a Next.js server action can't be safely replicated by hand — the
storefront and admin UI built on top of everything this phase modelled.*
