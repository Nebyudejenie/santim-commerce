# Project Execution State

Persistent engineering log for santim-commerce. This file is the resume
point if execution is interrupted: read this file, check `git log --oneline
-20` and `git status`, and continue from NEXT ACTION.

Last updated: 2026-08-21, commit `1ccfcde` on `main` (pushed; CI confirmed
green — every push through this commit has a passing CI run).

## MANDATE: MULTI-VENDOR MARKETPLACE TRANSFORMATION (current, active)

As of commit `1864141`, the mandate expanded from "harden the existing
single-vendor payment-integration app for production" (mostly complete —
see PRODUCTION-READINESS HISTORY below) to "transform this into a
full-featured multi-vendor marketplace comparable in functional depth to a
mature platform like eBay" — multi-vendor selling, seller
verification/reputation, order splitting and per-seller fulfillment,
commission/settlement, returns/refunds/disputes, richer search, reviews,
promotions/coupons, buyer-seller messaging, and the admin/observability
surface to run all of it.

This is genuinely large — realistically many sessions of real engineering,
not something to fake-complete in one pass (the mandate itself is explicit
about this: no placeholder workflows, no dead UI, no mock business logic).
Working through it in dependency order, each slice fully tested and pushed
before starting the next, tracked here so it survives a context reset.

### Roadmap (dependency order — do not skip ahead of an unchecked item
without a specific reason, since almost everything below depends on the
seller domain existing first)

- [x] **Seller domain foundation** (`1864141`) — `Seller` model with a
      PENDING/APPROVED/SUSPENDED/REJECTED lifecycle; `Product.sellerId` and
      `OrderLine.sellerId` (snapshotted); `Variant.sku` rescoped to
      unique-per-product (was globally unique — broke the "two sellers, same
      SKU" case a real marketplace needs). Seller apply flow (`/sell`) and
      admin review queue (`/admin/sellers`). Real hand-written
      expand-backfill-contract migration (8 existing seed products
      backfilled onto a placeholder "Legacy Catalogue" seller, zero data
      loss, zero schema drift afterward). Found and fixed an independent,
      real security gap while building this: no Server Action anywhere in
      the codebase checked its own authorization (all relied solely on the
      page/layout rendering their trigger form, which Next.js's own
      security guidance says is insufficient — Server Actions are
      independently-invokable endpoints). Fixed the pre-existing
      `resettlePaymentAction` the same way the new seller actions were
      built from the start. 8 new tests (6 integration, 2 unit), all
      passing; 7/7 real HTTP checks against a live server for the full
      apply→PENDING→approve→APPROVED flow, including page-level
      authorization (unauthenticated, non-staff).
- [x] **Seller listing management** (`7dd3210`) — `listing-service.ts`:
      createProduct (DRAFT + first variant + real inventory, one
      transaction), updateProduct, setProductStatus (DRAFT→ACTIVE→ARCHIVED
      →ACTIVE, publish requires ≥1 variant), addVariant, updateVariant.
      Every function's authorization: returns null / throws exactly as if
      the resource didn't exist for a non-owning seller (never
      forbidden-vs-not-found). UI: `/sell/products` (list),
      `/sell/products/new`, `/sell/products/[id]` (edit + publish +
      variant table). Images are URL-entry only (no upload pipeline built
      — a deliberate, documented v1 simplification, see NEXT ACTION).
      6 new integration tests including the adversarial cross-seller case
      (a seller cannot edit/publish/add-variant-to another seller's
      listing, verified against a real DB with zero side effects from the
      rejected calls). 7/7 real HTTP checks: create→still-invisible-as-
      DRAFT→cross-seller-404→publish→now-visible-on-PDP-and-shop.
- [x] **Buyer-facing seller visibility** (`5602fbb`) — "Sold by {store}"
      on the PDP, linking to a new public `/sellers/[slug]` storefront
      (APPROVED sellers only, their real ACTIVE products). Building this
      surfaced a real gap it then fixed: catalogue/cart/checkout only
      checked `product.status === ACTIVE`, never `seller.status ===
      APPROVED` — a suspended seller's listings would have stayed fully
      browsable, addable-to-cart, and purchasable (the mandate's own
      "seller becomes unavailable" edge case, section 5/19). Fixed at all
      three layers: browse (`VISIBLE_PRODUCT_WHERE`), add-to-cart
      (`addLine`), and checkout (`placeOrder`'s existing price-recheck
      pattern, extended). `checkout-service.ts` had ZERO dedicated tests
      before this — added a real integration test for the new gate
      specifically (full happy-path-through-real-payment was deliberately
      not attempted — no gateway mock exists in this suite, and a real
      outbound call with fake credentials doesn't belong in a test; see
      the test file's own comment). 8/8 real HTTP checks including a
      full pre/post-suspension visibility sweep across PDP, storefront,
      and shop listing.
- [~] **Order splitting / seller fulfillment** — read side done
      (`listSellerOrderLines`/`getSellerOrderDetail` in
      `seller-order-queries.ts`, `/sell/orders` + `/sell/orders/
      [orderNumber]`; only PAID/REFUNDED/PARTIALLY_REFUNDED orders shown —
      a seller finding out before payment clears is a false signal, not
      useful information; verified via real ownership-isolation tests, a
      seller cannot see another seller's order even with the real
      orderNumber). Still missing: per-seller fulfillment STATUS —
      `Order.fulfilmentStatus` is one field on the whole Order, which is
      wrong for a genuinely multi-seller order (seller A can ship their
      item while seller B hasn't; today there's no way to represent that).
      Needs either an `OrderLine.fulfilmentStatus` field or a proper
      `Fulfillment`/shipment-per-seller model — a real schema decision, not
      done yet. Payment collection stays single-PaymentIntent-per-Order
      (deliberate — see the seller-domain commit's own comment); this
      remains purely a fulfillment/reporting split, not a payment split.
      **Also found and fixed a severe, unrelated bug while building this**:
      building the sold-order detail page (which renders product images)
      surfaced that `next/image`'s `remotePatterns` allowlist only ever
      covered `picsum.photos` — meaning ANY product with a seller-supplied
      image from a different host (which `listing-service.ts`'s own
      "paste a link you already host" feature explicitly invites) 500'd
      the ENTIRE page, not just the image, for every visitor. Confirmed for
      real (created a product with a `example.com` image URL, hit its PDP,
      got a real 500 with Next's own `next-image-unconfigured-host`
      error). Fixed properly, not by loosening the allowlist (arbitrary
      remote hosts through next/image's own proxy is a real SSRF/cost-
      abuse surface): a new shared `<ProductImage>` component using a
      plain `<img>` for every seller-controlled image site (PDP gallery,
      ProductCard, cart lines, account order detail, seller sold-order
      detail — 5 sites) — admin/seed-controlled images (home page hero,
      collection tiles) were confirmed NOT seller-editable and correctly
      left on `next/image`. Re-verified the exact same previously-500ing
      product now returns 200 with a real `<img>` tag in the response.
- [x] **Commission & settlement ledger** (`b5b5706`) — `SellerLedgerEntry`:
      append-only SALE/COMMISSION/REFUND/ADJUSTMENT rows, balance always
      computed fresh from real history (`SUM WHERE settledAt IS NULL`),
      never a mutable running total. Wired into the ALREADY-EXISTING
      outbox pattern (worker's `deliver()` was an explicitly documented
      placeholder for the "order.paid" topic — not a new mechanism).
      Idempotent under real at-least-once outbox redelivery via a database
      unique constraint (`@@unique([orderLineId, type])`), verified by
      calling the settlement function 3× for the same order and confirming
      exactly one SALE + one COMMISSION entry, not three. Verified a
      multi-seller order settles each seller's own commission rate
      independently (5%/20% sellers never leak into each other's ledger).
      `/sell/earnings` page, re-verified end-to-end over real HTTP.
      **Deliberately NOT built**: actual money movement (a real SantimPay
      B2C payout to pay a seller out) — `docs/01-santimpay-protocol-
      spec.md`'s own §8 open-questions list flags refund/payout semantics
      against the real gateway as unconfirmed with SantimPay ops.
      Fabricating a specific real-money gateway call sequence against
      unconfirmed API semantics is a different risk category than a normal
      engineering judgment call; `settledAt` exists on the schema so this
      doesn't need another migration when that capability is built with
      real confirmation. This is also why **returns/refunds** (next item)
      is scoped to the workflow/data side only, not the money-movement
      side, for the same reason.
- [x] **Reviews & ratings** (`f94ffbd`) — `ProductReview`/`ReviewReport`.
      Verified purchase is an ENFORCED precondition (a real order line
      required, not a cosmetic badge) — the exact same
      `findEligibleOrderLine` function gates both the write path and the
      UI's decision to show the form, so they can never drift. One review
      per (product, user) via a real DB constraint. No separate
      SellerReview model — a seller's rating is the average across their
      own products' reviews (real marketplaces mostly work this way at the
      foundation). Moderation queue (`/admin/reviews`), seller responses
      (ownership-checked), reporting (one report per user per review, also
      a real constraint). 7 new tests including the core adversarial case
      (a user who never bought the product cannot review it — verified
      zero rows created) and HIDDEN-reviews-excluded-from-aggregation.
      Verified end-to-end over real HTTP: a real buyer with a real PAID
      order sees the write-a-review form, a non-buyer doesn't, and a
      submitted review appears on the real PDP with the correct
      5.0/1-review aggregate.
- [x] **Returns, refunds, disputes** (`6b79e96`) — `ReturnRequest`: buyer
      requests (only for a FULFILLED line), seller approves/rejects on
      their own lines (ownership-checked), admin can override regardless
      of seller (dispute escalation). Approval does 3 real things in one
      transaction: atomic inventory restock, OrderLine → RETURNED (already
      anticipated by fulfilment-aggregate.ts), and a REFUND ledger entry
      that exactly cancels the original SALE+COMMISSION net — computed
      from the real prior entries, not guessed. Same money-movement
      boundary as settlement: no actual bank transfer back to the
      customer (unconfirmed SantimPay semantics). 7 new tests including
      restock+ledger-reversal verified together. Verified end-to-end over
      real HTTP AND a direct SQL query confirming onHand genuinely went
      3→4, not just that the app claimed it did. UI: buyer request button,
      `/sell/returns`, `/admin/returns`.
- [x] **Coupons & promotions** — platform-wide, admin-issued coupons
      (`Coupon` + `CouponRedemption`, purely additive migration). Deliberately
      scoped OUT of v1: seller-issued/listing-scoped coupons — meaningfully
      bigger feature (partial-cart discount math, which seller's ledger
      absorbs the cost), documented rather than half-built. `redeemCoupon`
      runs INSIDE checkout-service.ts's order-creation transaction, before
      `totalSantim` is computed: atomically decrements a total redemption
      cap via the same conditional-UPDATE-then-check-row-count pattern as
      inventory reservation, and the actual `CouponRedemption` row (created
      after the order, so it has a real orderId) carries the hard
      `@@unique([couponId, userId])` backstop against a same-user double-
      redemption race — verified directly with a real concurrent-checkout
      test (two simultaneous redemptions of a `redemptionsRemaining: 1`
      coupon: exactly one wins, count never goes negative). Coupons require
      a signed-in customer in v1 (guest checkout + coupon is rejected
      before any DB work, with a real integration test) — the per-user
      limit has nothing to key on for a guest. VAT is computed on the
      post-discount subtotal; the free-shipping threshold is evaluated on
      the pre-discount subtotal (a merchandise-value threshold a coupon
      shouldn't also unlock) — both documented as judgment calls the same
      way the pre-existing VAT-on-shipping question already is. Checkout UI
      has a live "Apply coupon" preview (a read-only dry-run, no
      reservation) so the customer sees the real discount before paying;
      the authoritative check still happens at real checkout, same
      optimistic-then-authoritative pattern already used for price/seller-
      status re-checks. Admin UI at `/admin/coupons` (create + activate/
      deactivate, real redemption counts from `_count`). 15 + 3 new tests
      (calculation unit tests, coupon-service integration tests including
      createCoupon's birr-parsing/validation, checkout-service guest-
      guard). Verified end-to-end over real HTTP: coupon field present only
      when signed in, absent for guests, admin page correctly gated and
      showing a real seeded coupon; a non-admin is redirected away.
- [x] **Search depth** — real Postgres full-text search, not a `title ILIKE
      '%...%'` scan. `Product.searchVector` is a hand-written (Prisma has no
      DSL for it) `GENERATED ALWAYS AS ... STORED` tsvector, weighted
      title(A)/brand+subtitle(B)/description(C), GIN-indexed; ranked via
      `ts_rank`. Typo tolerance via a `pg_trgm` GIN index on title —
      similarity fallback kicks in when a full-text match misses (verified:
      "essentail" / "Corduroy Jaket" still find the real product). A small,
      honestly-scoped synonym layer (`synonym-expansion.ts`, pure/unit-
      tested) rewrites a query that exactly matches a curated term into a
      `websearch_to_tsquery`-compatible `OR` group — not a claim of general
      synonym support. Faceted filtering (brand, price range) and sorting
      (relevance/newest/price) via safely-parameterized `Prisma.sql`
      fragments (never string-concatenated), real pagination via
      `COUNT(*) OVER()`. Same visibility rule as every other catalogue read
      (VISIBLE_PRODUCT_WHERE, now exported from catalogue-service.ts and
      reused, not re-implemented) — verified directly: a suspended seller's
      product and a DRAFT listing never surface through search OR
      autocomplete even on a perfect keyword match. Autocomplete is a plain
      callable Server Action (not a form action), debounced client-side.
      UI: search bar + dropdown in the site header, `/search` results page
      with brand/price/sort facets as real backend-driven links (bookmark-
      able, works without JS). 15 new tests (5 pure synonym-expansion unit
      tests, 10 search-service integration tests including the suspended-
      seller-leak and typo-tolerance cases) — all passing against real
      Postgres. Verified end-to-end over real HTTP: keyword search, typo
      search, brand filter, price filter all return the exact same counts
      the service layer computed directly.
- [x] **Seller reputation metrics** — real metrics from real order/return/
      review history, not placeholder scores (`seller-reputation-service.ts`).
      Completion/cancellation/return rates are plain indexed COUNT queries
      (cheap regardless of history size); late-shipment rate and review-
      response time need per-row timestamp diffs, so those are computed
      over a bounded, most-recent sample (documented scale trade-off, not
      an oversight). Two real, documented judgment calls: "late shipment"
      is measured against a default 48h fulfilledAt-minus-paidAt SLA (this
      codebase's OrderStatus enum has no PROCESSING/SHIPPED/DELIVERED
      granularity for a real SLA to attach to); "dispute rate" is the
      fraction of resolved returns needing ADMIN escalation, detected by
      comparing ReturnRequest.resolvedByUserId against the seller's own id
      (a seller-resolved return stores the seller's id there, an admin-
      resolved one stores the admin's — different id namespaces, verified
      not to collide). Buyer-facing subset (rating, completion rate, return
      rate) shown on the public seller storefront; full metrics on the
      seller's own `/sell/reputation`; a bulk, single-query (not per-row —
      the real N+1 trap this would otherwise be) rating column added to
      `/admin/sellers`. 5 new integration tests including the zero-data
      seller (every rate null, never NaN/crash) and the seller-vs-admin
      dispute disambiguation. Verified end-to-end over real HTTP: storefront
      trust signals, seller dashboard, and admin rating column all show the
      exact figures computed from real seeded order/review data.
- [x] **Admin marketplace controls** — reviewed the full admin surface
      against the master mandate's list before adding anything, specifically
      to avoid rebuilding what already existed: dispute resolution
      (`/admin/returns`, already shipped with the returns feature),
      promotion management (`/admin/coupons`, already shipped), and the
      order audit trail (`/admin/orders/[orderNumber]`'s "Order timeline"
      section already renders real `OrderEvent` rows — confirmed BEFORE
      building a redundant audit-log page) were all already real and
      working, not gaps. Seller reinstatement was suspected to be a gap
      (no dedicated action/button) but turned out not to be one either:
      SUSPENDED→APPROVED is a valid transition and the existing Approve
      button already reuses `approveSellerAction` for it — verified against
      seller-state-machine.ts before "fixing" something that wasn't broken.
      The one real, concrete gap found: commission config had zero admin
      UI — `Seller.commissionBps` could only ever be set at seller-creation
      time. Added `setSellerCommission` (validates 0-10000bps) + an inline
      edit form on `/admin/sellers`. The one property that actually matters
      here — verified with a dedicated integration test — is that changing
      a seller's rate can NEVER retroactively alter a SellerLedgerEntry
      that already exists: settlement computes and persists the commission
      once, at settlement time, and that entry is immutable afterward,
      same "historical record, not a view" principle as everywhere else in
      this ledger. 3 new tests (successful adjustment, out-of-range
      rejection, ledger-immutability-after-rate-change). Verified end-to-
      end over real HTTP that the admin sellers page renders a seller's
      real current commission rate in an editable field.

      DELIBERATELY NOT BUILT, with reasoning: a generic cross-entity
      `AuditLog` table (this codebase's existing pattern — reviewedBy/
      reviewedAt on Seller, resolvedByUserId/resolvedAt on ReturnRequest,
      OrderEvent per order — already covers "who did what, when" at each
      entity that needs it; a parallel generic table would be a second,
      driftable source of truth, not a real improvement). A live platform-
      settings UI for the VAT rate/shipping thresholds/default commission
      (these remain named constants with their own documented judgment-call
      comments — see tax-service.ts, shipping-service.ts — turning them
      into runtime-editable config is a real feature with its own real
      scope, not a checkbox to tick here). A buyer-seller messaging system
      (named in the master mandate's admin list as "content" moderation
      surface, but no messaging system exists yet to moderate — building
      messaging AND its moderation UI is its own multi-part feature).

### Post-roadmap: the mandate's own "do not stop when the TODO list is
finished" instruction (section 28) — continuing past the 11-item roadmap
above once every item was checked off. A security review of the whole
roadmap's diff (coupons through commission config) was run first via a
dedicated sub-agent and came back clean: every raw SQL call is a
Prisma-parameterized tagged template, every new Server Action gates its own
authorization, and the coupon redemption path can't be manipulated via
client input. Then an Explore audit against the master mandate's full
buyer/seller/admin feature list, specifically to find real remaining gaps
rather than inventing busywork.

- [x] **SEO foundations** — this codebase had genuinely zero SEO
      infrastructure before this pass: no `robots.ts`/`sitemap.ts`, no
      `metadataBase`, no structured data, no canonical URLs, no breadcrumbs.
      Added: `app/robots.ts` (disallows /admin, /account, /sell, /cart,
      /checkout, /api/, /login, /register — all private or dynamic, none of
      them worth indexing), `app/sitemap.ts` (real, live-queried product/
      seller/collection URLs via new lightweight `listProductSlugsForSitemap`/
      `listSellerSlugsForSitemap` — slug+updatedAt only, not
      listAllProducts()'s eager variant/image includes), `metadataBase` +
      default OG tags on the storefront root layout, `robots: {index:false}`
      on the admin root layout (admin has no business being crawled),
      canonical URL + OpenGraph tags + real Product/BreadcrumbList JSON-LD
      on the product page — built strictly from data already loaded on that
      page (no fabricated aggregateRating when a product has zero reviews).
      A real bug was caught by the end-to-end HTTP verification itself, not
      by inspection: `robots.txt` was being statically prerendered at BUILD
      time, freezing whatever `process.env.APP_URL` happened to be during
      `next build` into the sitemap link forever — a real problem for any
      deployment where build-time and runtime env differ. Fixed by adding
      `export const dynamic = "force-dynamic"` (sitemap.ts already had it).
      No new tests (pure metadata/routing, no new business logic) — verified
      instead by parsing the real JSON-LD off a live server and confirming
      it exactly matches the seeded product's real price/brand/description.

- [x] **Wishlist / saved items** — new `WishlistItem` model, no separate
      "Wishlist" container: each user has exactly one implicit wishlist
      (their own rows), the same reasoning CartLine doesn't need a
      standalone Cart-per-purpose abstraction. `@@unique([userId,
      productId])` makes toggle-add idempotent under a real concurrent
      double-click (verified with a dedicated race test), not an
      application-level check-then-write. A REAL hazard surfaced applying
      this migration: Prisma's diff engine doesn't understand the
      hand-written `searchVector` GENERATED column from the search feature
      (only sees the `Unsupported("tsvector")` placeholder) and generated a
      spurious `ALTER COLUMN ... DROP DEFAULT` against it, which failed
      against a real generated column and rolled back the whole migration
      transaction (confirmed via direct SQL inspection: search indexes and
      seed data were untouched, `wishlist_items` was never created — the
      rollback was clean). Fixed by hand-editing the migration file to drop
      the bogus statements, surgically removing the one stale
      `_prisma_migrations` tracking row for the failed attempt (not a
      `prisma migrate reset`, which would have destroyed all real seed data
      just to fix Prisma's own bookkeeping), then re-applying the corrected
      SQL. Every future migration touching `products` needs the same check.
      `listWishlist` deliberately does NOT filter out an item that's since
      gone unavailable (unpublished product, suspended seller) — a real
      wishlist says "no longer available", it doesn't silently make the
      item disappear as if it were never saved (verified directly: an item
      stays listed with its real current status after its product/seller
      state changes). Wishlist toggle button on the product page (a plain
      "Sign in to save" link for guests, no round-trip through the action
      just to redirect); `/account/wishlist` page. 5 new integration
      tests. Verified end-to-end over real HTTP: a real saved item renders
      on both the wishlist page and as "Saved" (`aria-pressed="true"`) on
      its own product page.
- [x] **Grid-level wishlist buttons** — the follow-up deliberately deferred
      when wishlist first shipped. `ProductCard` (shared by /shop, /, search,
      collection pages, and seller storefronts — 5 consumer pages, all
      updated) restructured from one big `<Link>` wrapping the whole card
      into two sibling `<Link>`s (image, body) plus the wishlist toggle as a
      third sibling — an `<a>` cannot legally contain interactive content
      like a `<form>`/`<button>`, so nesting the toggle inside the original
      single Link would have been invalid HTML. New `WishlistButton
      compact` variant (icon-only, no "Save"/"Saved" label) absolutely
      positioned over the image corner. New `listWishlistedProductIds()` —
      one bulk query per page (`Set<string>`), not N (one per card); every
      consumer page fetches it once alongside its product list and passes
      `wishlisted={ids.has(product.id)}` per card, exactly the N+1 several
      list pages the original deferral was worried about, done as one query.
      1 new integration test (ownership-scoped bulk lookup). Verified
      end-to-end over real HTTP on /shop, /search, and the product page:
      real per-card wishlisted state renders correctly for a signed-in user
      (confirmed against the actual seeded product count via a reliable
      extraction method, after an initial naive substring-count check gave
      a misleading result — Next.js embeds a duplicate serialized RSC
      payload alongside the rendered HTML, which inflates some raw
      grep-based counts and not others); guests get plain "Sign in to save"
      links with zero interactive toggle buttons, confirmed exactly 0
      `aria-pressed` attributes present for a guest request.
- [x] **Address book** — no schema change needed; the `Address` model had
      existed since an earlier phase with zero real usage. New
      `address-service.ts`/`address-actions.ts`, ownership-checked exactly
      like every other per-user resource in this codebase (a cross-user
      update/delete attempt gets the identical "not found" a real miss
      would, verified with a dedicated integration test — no distinguishable
      "forbidden"). New `/account/addresses` page for CRUD. Checkout gets a
      "Deliver to" selector when the signed-in customer has saved addresses,
      defaulting to their most recent one; picking a different one remounts
      the address fields with fresh `defaultValue`s (an uncontrolled-input
      reset via `key`, not a fully-controlled form — deliberately the
      lower-risk way to touch the payment-critical checkout path) and a
      "save this address" checkbox appears only in new-address mode. Saving
      from checkout is explicitly a best-effort, post-order write (see
      address-service.ts's `saveAddressFromCheckout`) — never inside
      checkout-service.ts's transaction, and a failure there is logged and
      swallowed, never surfaced to the customer or allowed to affect the
      real payment redirect. Order.shippingAddress stays exactly what it
      already was: a snapshotted JSON blob, never a foreign key to Address —
      editing or deleting a saved address later must never be able to alter
      a past order's real shipping address. 6 new integration tests.
      Verified end-to-end over real HTTP: a real saved address renders on
      both `/account/addresses` and inside the checkout "Deliver to"
      selector; a guest is correctly redirected away from the account page.
- [x] **Customer notifications** — no real email/SMS provider credentials
      exist in this environment, so this is the in-app version: a new
      `Notification` model, populated exclusively by the outbox worker (see
      worker/index.ts's `deliver()`), never synchronously wherever the
      underlying state change happens — the same reasoning settlement
      ledger entries already followed. `enqueue()` was extracted out of
      payment-service.ts (its original, sole caller) into a shared
      `outbox.ts` so seller-fulfillment and returns could enqueue their own
      topics without an awkward cross-import into a payment-specific
      module. Four real events wired end to end: order.paid, order.
      payment_failed (already enqueued, just never consumed for this
      before), plus two genuinely new enqueue points added at their real
      source — `order.line_fulfilled` (seller-order-fulfillment.ts, only on
      the real "shipped" transition, not the undo path) and
      `return.resolved` (return-service.ts, both the APPROVED and REJECTED
      branches — the REJECTED path didn't even have a transaction before
      this, needed one so the enqueue can't succeed without the state
      change, or vice versa). Every notifyX function is idempotent via a
      real `dedupeKey` unique constraint under the outbox's at-least-once
      redelivery — verified directly by calling the same notify function
      twice and confirming exactly one row. A guest order (`userId` null)
      is silently skipped, not an error — there's no account to notify.
      Verified the topic-string wiring is exactly consistent by directly
      cross-referencing every `enqueue()` call site's topic/payload-key
      strings against the worker's dispatch table (all 5 call sites, 4
      topics, exact match) — the classic stringly-typed risk this pattern
      creates, checked for real rather than assumed. Bell icon + real
      unread badge in the site header (signed-in users only), new
      `/account/notifications` page with mark-read/mark-all-read. 12 new
      tests (7 notification-service + 5 added to the existing fulfillment/
      return test files verifying the real outbox message gets enqueued,
      not just that the underlying state changed). Verified end-to-end over
      real HTTP: unread badge count and notification content both match
      real seeded data exactly; a guest sees no bell at all.
- [x] **Admin business-metrics dashboard** — new `getBusinessMetrics()`
      (admin-queries.ts) alongside the existing `getDashboardStats()`, both
      shown on the same page now under separate headings ("Business, last
      30 days" / "Operational health") since they answer different
      questions: how the marketplace is actually performing vs. is
      anything broken right now. Real GMV (settled orders paid in the
      window), real commission revenue (from actual `SellerLedgerEntry`
      COMMISSION rows, correctly sign-flipped for display — they're stored
      negative), active/pending seller counts, platform-wide return rate,
      and a real top-5-sellers-by-revenue table via `orderLine.groupBy`.
      5 new integration tests (admin-queries.ts had zero coverage before
      this) verify each figure against real seeded orders/ledger entries —
      GMV specifically checked for both inclusion (recent orders) and
      exclusion (an order paid 60 days ago, given a deliberately huge
      value so any accidental inclusion is unmissable against ordinary
      concurrent-test noise).

      A real, separate bug surfaced and was fixed while adding this file:
      `checkout-service.integration.test.ts`'s two existing tests asserted
      `orders.length === 0` filtered by the literal, UNSUFFIXED email
      `"buyer@example.et"` — a string over a dozen other integration test
      files also use verbatim for their own, unrelated real orders. Because
      `node --test` runs integration test FILES concurrently by default,
      those assertions (and that file's own cleanup, which deleted by the
      same bare prefix) were exposed to real cross-file interference —
      confirmed by reproducing 3 real failures in a full-suite run, then
      confirming 3 consecutive clean 104/104 runs after scoping both the
      assertions and the cleanup to a per-test-unique `buyer-<suffix>@...`
      email instead. This also retroactively explains a single flaky-test
      incident from earlier in this session that had been attributed to
      "environmental noise" without a confirmed root cause — same bug,
      just rarer before this phase added enough concurrently-running files
      sharing that literal string to make it show up reliably.

      Verified end-to-end over real HTTP: GMV, commission revenue, and the
      top-seller entry all match the real seeded figures exactly (1,234.56
      ETB / 123.46 ETB, computed from 123,456 santim at a real 10%
      commission rate).
- [x] **Seller-issued coupons** — coupons were previously admin-only,
      platform-wide, applied to the whole cart subtotal; schema.prisma's own
      comment on `Coupon` explicitly named this exact gap as deliberately
      deferred ("partial-cart discount math, which seller's ledger absorbs
      the cost — a meaningfully bigger feature"). New `Coupon.sellerId`
      (nullable — null keeps every existing admin coupon's behavior exactly
      unchanged) plus a new `COUPON_DISCOUNT` ledger entry type.

      The real complexity this feature is actually about: a seller-issued
      coupon must discount ONLY that seller's own lines in the cart, never
      a different seller's who happens to share the same order — funding a
      stranger's discount would be a real accounting bug, not a rounding
      nit. `coupon-service.ts`'s `relevantSubtotal` is the one function
      that decides whole-cart (admin coupon) vs. seller-scoped subtotal
      (seller coupon) for both the minimum-spend check and the discount
      calculation — every call site (`redeemCoupon`, `previewCouponDiscount`)
      now takes a per-seller cart-line breakdown instead of a single
      number. `checkout-service.ts`'s real, authoritative redemption
      already derives this breakdown server-side from the real cart, as it
      always did; only the checkout FORM's non-authoritative preview now
      also needs it, sent as a JSON hidden field (still non-authoritative —
      the real enforcement is checkout-service.ts's own server-derived
      cart, unchanged).

      On settlement, a seller-scoped redemption gets one additional
      COUPON_DISCOUNT ledger entry (always negative) against the funding
      seller specifically — attributed to that seller's first line in the
      order (SellerLedgerEntry requires a real orderLineId; a coupon
      discount is an order-level, not line-level, fact, and the
      CouponRedemption row is the true audit record regardless of which
      line the entry is attached to). An admin/platform-wide coupon
      redemption creates no such entry at all — the marketplace still
      absorbs that discount, unchanged from before this feature existed.
      Idempotent under the outbox's real redelivery via the same
      `@@unique([orderLineId, type])` constraint every other ledger entry
      already relies on.

      New `/sell/coupons` page (ownership-scoped toggle — a cross-seller
      attempt is indistinguishable from not found, same as every other
      ownership-scoped mutation this session); `CreateCouponForm`/
      `ToggleCouponActiveButton` made reusable between the admin and seller
      pages via an injected Server Action rather than duplicating the form.
      `listCoupons()` (admin) now excludes seller-issued coupons — admin
      manages platform coupons, sellers manage their own; a combined
      oversight view is a natural, deliberately deferred follow-up.

      13 new tests (5 in coupon-service — multi-seller scoping, the
      seller-not-in-cart rejection, seller-scoped minSubtotalSantim, admin/
      seller list separation, ownership-scoped toggle; 3 in
      settlement-service — the funding seller's entry, an unrelated
      seller sharing the order staying completely unaffected, redelivery
      idempotency, and the admin-coupon-creates-no-entry case) — all 20
      pre-existing coupon tests still pass unchanged, confirming admin
      coupons kept their exact original behavior. Verified end-to-end over
      real HTTP: a real seller-issued coupon renders on `/sell/coupons`;
      the real checkout page's hidden cartLines field carries the real
      seller id and line total needed to scope the preview correctly.
- [x] **Product Q&A** — the eBay/Amazon "Ask a question" pattern; confirmed
      absent (no model, zero matches anywhere). New `ProductQuestion`,
      deliberately NOT gated on proof-of-purchase the way `ProductReview`
      is — the whole point is letting someone who hasn't bought yet get a
      real answer before they do. Any signed-in user may ask; answering is
      ownership-scoped to the product's own seller (a cross-seller attempt
      is indistinguishable from not found, same discipline as every other
      ownership-scoped mutation this session).

      A real modeling bug surfaced and was caught by its own integration
      test, not by inspection: `answeredByUserId` initially referenced
      `User`, but the service passes a `Seller` id (this app has no
      multi-user seller accounts — Seller.ownerId's own comment: one store
      per user in v1 — so the STORE answered, not a particular staff
      account). The FK violation fired on the very first real write.
      Renamed to `answeredBySellerId`, referencing `Seller` directly, the
      same way `SellerLedgerEntry.sellerId` does. Since the first,
      incorrect migration had only ever been applied locally (never
      pushed), it was cleanly replaced rather than patched — dropped the
      table, deleted its `_prisma_migrations` tracking row, hand-wrote a
      corrected migration (`ALTER TYPE ... ADD VALUE IF NOT EXISTS` for the
      `NotificationType` enum value, since Postgres has no `DROP VALUE` and
      the earlier attempt had already added it for real), and applied it
      with `prisma migrate deploy` — `migrate dev`'s own drift-detection
      would have demanded a full destructive reset over this exact
      self-inflicted, harmless drift.

      Answering enqueues a real `question.answered` outbox message,
      wired through the same notification pipeline as every other
      customer-facing event this session (new `QUESTION_ANSWERED`
      notification type). New `/sell/questions` console page — the
      "needs a reply" queue, listing only that seller's own unanswered
      questions. Questions section added to the product page (`#questions`
      anchor), showing every question whether answered or not — a real
      storefront's Q&A shows what's already been asked, not just a curated
      answered subset.

      5 new integration tests. Verified end-to-end over real HTTP: both an
      answered and an unanswered real question render correctly on the
      product page with the right content in each state; a guest sees a
      "Sign in to ask a question" link instead of the interactive form;
      the seller console's queue shows only the real unanswered question,
      correctly excluding the already-answered one.
- [x] **Admin featured-product curation** — `Product.featured` has existed
      in the schema and been read by `listFeaturedProducts` (the
      homepage's "Featured" section) since an earlier phase, but confirmed
      nothing anywhere could ever set it to true outside seed data — no
      admin UI, no seller UI. Deliberately kept OFF the seller's own
      `updateProduct` (no `featured` field there at all): letting sellers
      self-promote onto the homepage would turn "featured" into a race,
      not a real editorial decision, so this is admin-only by design, not
      oversight. New `setProductFeaturedAsAdmin` (listing-service.ts) and
      `listAllProductsForAdmin` (admin-queries.ts, deliberately NOT
      catalogue-service.ts's VISIBLE_PRODUCT_WHERE-filtered
      `listAllProducts` — admin needs to see DRAFT/ARCHIVED listings and
      products from PENDING/SUSPENDED sellers too, verified directly: a
      DRAFT product from a SUSPENDED seller shows up for admin even though
      the storefront would never show it). New `/admin/products` page
      (search by title, a real cross-seller catalog view admin didn't have
      at all before this). 2 new integration tests. Verified end-to-end
      over real HTTP: the real product and its Feature button render on
      `/admin/products`; search correctly filters to a match and correctly
      shows the empty state for a non-match; a guest is redirected to
      `/admin/login`.
- [x] **Recently viewed products** — confirmed absent (no model, zero
      matches anywhere). New `RecentlyViewed`, signed-in users only —
      matching the established convention this session (wishlist,
      notifications) that engagement/tracking features need an account;
      there's no cookie-based guest tracking. `recordView` is a deliberate,
      real exception to "GET requests should be side-effect-free" —
      recording a page view is a universal, accepted exception across the
      real web, and the write is a single fast upsert on a real
      `@@unique([userId, productId])` constraint: a repeat view updates
      `viewedAt` in place, it never grows an unbounded per-view log.

      A real, non-hypothetical ordering bug was caught and fixed before it
      shipped: `viewedAt` is millisecond-precision, and two views (a fast
      double-click, a prefetch) can land in the same millisecond, making
      "most recent first" non-deterministic on a tie. Fixed by adding `id`
      (a cuid, real-monotonically-increasing) as a secondary sort key —
      verified the resulting test suite stays consistently green across 3
      repeated runs, not just a single lucky pass.

      Filtered to currently-visible products only (reuses catalogue-
      service.ts's `VISIBLE_PRODUCT_WHERE`) — the opposite choice from
      wishlist, deliberately: wishlist keeps showing an unavailable item
      because saving it was a real intentional signal, but a passively
      recorded view of something no longer buyable isn't worth surfacing.
      New homepage "Recently viewed" section, reusing the same `ProductCard`
      wishlist/grid-button wiring already built this session. 5 new
      integration tests. Verified end-to-end over real HTTP by actually
      visiting two real product pages in sequence (not pre-seeded rows —
      exercising the real PDP write path) and confirming the homepage
      correctly showed the second-viewed product first; a guest sees no
      such section at all.
- [x] **Seller business-metrics dashboard** — `/sell/earnings` had only a
      flat balance (payable/settled/lifetime) and a flat ledger list — no
      trends, no "how's business going" view, mirroring the exact gap
      admin's own dashboard had before `getBusinessMetrics()` earlier this
      session. New `getSellerBusinessMetrics(sellerId)`
      (settlement-service.ts) — a single seller's own version of the same
      question, scoped down to one store: real orders count, gross sales,
      and top products, over the last 30 days.

      Deliberately groups top products by the SNAPSHOTTED `productTitle`
      on OrderLine, not a live Product join — OrderLine's own module
      comment already states the philosophy this follows: "a historical
      record, not a view." A renamed or deleted product must never
      silently break or misattribute past sales figures. Filters by
      `Order.paidAt`, not the line's own `createdAt` (order-placement
      time) — the same "when did the sale actually happen" semantic
      admin-queries.ts's `getBusinessMetrics` already uses for its GMV
      window, for the same reason: a delayed or resumed payment can leave
      `createdAt` meaningfully earlier than when the sale was actually
      real. This was caught and fixed before the tests were even written,
      by checking the admin version's own established semantic rather
      than picking a plausible-looking field.

      Unlike admin's marketplace-wide aggregate, this metric is scoped to
      one specific seller id — genuinely no cross-file interference risk
      even under `node --test`'s concurrent file execution, so its tests
      use exact-equality assertions rather than admin-queries.ts's
      threshold-bound workaround. 2 new integration tests. Verified
      end-to-end over real HTTP: real order count, gross sales, and a real
      top-selling product all render correctly on `/sell/earnings`,
      matching the seeded figures exactly.

### Working discipline for this mandate (carried over from what already
proved out this session — do not relax these just because the scope grew)

- Every schema change that touches a table with real rows gets a
  hand-written expand-backfill-contract migration, verified for zero drift
  afterward (`prisma migrate dev` reporting "already in sync"), not a bare
  `prisma migrate dev` against non-empty tables.
- Every new Server Action checks its own authorization — never rely on the
  page/layout that renders its trigger form.
- Every new feature gets real tests (unit for pure logic, integration
  against real Postgres for anything DB-backed) AND, where practical, a
  real HTTP end-to-end check against a live server — not just "the code
  looks right."
- Full regression suite (`pnpm -r typecheck && pnpm -r lint &&
  pnpm --filter @santim/santimpay test && pnpm --filter @santim/web
  test:unit && pnpm --filter @santim/web test:integration`) before every
  commit, real CI watched to a genuinely uncontested completion before the
  next push (this session already got burned once by pushing too fast and
  triggering the concurrency-group's `cancel-in-progress` — see
  PRODUCTION-READINESS HISTORY below).
- State machines for anything with a lifecycle live in their own pure,
  zero-import module (see `seller-state-machine.ts` following
  `orders/state-machine.ts`'s precedent) — required for `test:unit`
  (plain `node --experimental-strip-types`) to even run them, and it's
  also just better-tested code.

- [x] **Bulk CSV import/export for sellers** — identified as the next
      plausible candidate in this file's own prior "where to resume" note
      and built. New `csv.ts` — a small, real, hand-written RFC4180-shaped
      parser/writer (quoted fields, embedded commas/newlines, escaped
      quotes), no external dependency, consistent with this codebase's
      existing self-reliance for well-understood, boundedly-complex code
      (`carrier-client.ts`'s mock is the same reasoning). 11 unit tests,
      including a real round-trip property test (write then re-parse
      returns the original data unchanged).

      Import deliberately only CREATES new listings by calling
      `createProduct` itself once per row — never a parallel, drift-prone
      copy of that validation logic — so a CSV row is validated by exactly
      the same rules a manual form submission is. A bad row never aborts
      the batch: verified directly with a real 3-row CSV (good, bad,
      good) that the two valid rows get created and the bad one reports
      its own real per-row error, not a stack trace or a zero-listings
      abort. Bulk-UPDATING an existing listing by SKU via CSV is real,
      meaningfully bigger functionality (matching rows to existing
      variants, deciding what "update" means for a field a row leaves
      blank) — deliberately not built here, matching this session's
      established scoping discipline for genuinely bigger follow-ups.

      New `GET /sell/products/export` (a Route Handler, not a Server
      Action — a real file download needs real Content-Type/Content-
      Disposition headers a Server Action can't set) and an import form on
      `/sell/products`. 6 new integration tests, including a real
      export-then-reimport round-trip. Verified end-to-end over real HTTP:
      downloaded a real CSV with a real comma-containing product title and
      confirmed the exported field was correctly quoted (proving the
      writer's quoting logic against real production data, not just
      synthetic unit-test input) — every value matched the seeded product
      exactly; a guest is redirected to `/login`, gets no file.
- [x] **Admin order export (CSV)** — low marginal cost once `csv.ts`
      existed for the seller-catalogue feature above, and a real gap: no
      way for admin/finance to get order data out for reconciliation.
      New `exportOrdersCsv` (admin-queries.ts) reuses `listOrders`'s exact
      filter shape with a real, orders-of-magnitude-larger cap (10,000
      rows, bounded so a runaway export can't tie up a request
      indefinitely — same reasoning as the CSV import path's own file-size
      cap). New `GET /admin/orders/export?status=&q=`, preserving
      whatever filter is currently applied on `/admin/orders` — export the
      view you're looking at, not always the whole table.

      A real, not hypothetical Next.js gap handled correctly: a co-located
      `(dashboard)/layout.tsx` wraps PAGE rendering only — a `route.ts`
      file is never wrapped by a layout even nested in the same segment —
      so this Route Handler checks its own `requireRole("STAFF")`
      directly, same discipline as every Server Action in this codebase
      checking its own authorization rather than trusting a page/layout.

      Scoped its own test to a real, unique order-number search filter
      rather than an unfiltered export — `exportOrdersCsv` is a
      marketplace-wide query with no seller scoping, and an unfiltered
      call would have the same real cross-file interference risk under
      `node --test`'s concurrent execution that `getBusinessMetrics`
      already had to work around; filtering by this test's own unique
      order number sidesteps it entirely rather than reaching for a
      threshold-bound workaround it didn't need. 1 new integration test.
      Verified end-to-end over real HTTP: a real order's real figures
      (status, fulfilment, birr total, real timestamps) came back exactly
      right in the downloaded CSV; a guest is redirected to
      `/admin/login`, gets no file.
- [x] **Back-in-stock notifications** — confirmed absent (no model, zero
      matches anywhere). New `BackInStockRequest`, scoped to a VARIANT not
      the product — a sold-out size/color is what a real customer is
      waiting on, not the product as a whole (see AddToCartForm's own
      per-variant stock display). Wired into BOTH real places inventory
      increases: a seller's manual correction (`updateVariant`) and a
      return being approved (`return-service.ts`) — it doesn't matter
      which source restocked a variant, a waiting customer gets notified
      either way.

      A real, non-hypothetical bug was found and fixed BEFORE it shipped,
      through careful reasoning about the re-arm semantics, not by a
      failing test surfacing it first: the first draft built each
      notification's dedupeKey from `request.id` alone. Since `request.id`
      is stable across a re-arm (a customer re-requesting after already
      being notified resets `notifiedAt` on the SAME row, per the real
      `@@unique([userId, variantId])`, rather than creating a second one),
      that key would collide forever after the FIRST notification and
      silently swallow every real one after a legitimate re-request — a
      customer who re-armed would never actually hear back, with no
      visible error anywhere. Fixed by adding `notificationCount`
      (incremented on each real notify) to the model and folding it into
      the dedupeKey, so each notify-cycle gets a genuinely distinct key
      while staying stable — and therefore still correctly idempotent —
      within a single cycle's own redeliveries. A dedicated test proves
      the fix actually works: two full stockout-request-restock cycles
      for the same customer on the same variant produce two real,
      distinct notifications, not one.

      `enqueueBackInStockCheck` is deliberately NOT gated on "was this
      variant exactly zero before this specific update" at either
      call site — `notifiedAt IS NULL` is the real idempotency guard
      inside `notifyBackInStock` itself, so an extra enqueue for an
      unrelated stock bump is at worst a cheap, correctly-no-op'd query,
      never a duplicate notification; this sidesteps needing to
      coordinate a consistent "before" snapshot across two structurally
      different call sites (`updateVariant`'s absolute set vs.
      `return-service.ts`'s atomic increment).

      New button on the product page when the selected variant is sold
      out — "Notify me when back in stock" for a signed-in customer who
      hasn't requested yet, a real "you'll be notified" message for one
      who already has, a sign-in prompt for a guest. 13 new integration
      tests across four files (the service itself, the notification
      creation and its re-arm fix, and the real enqueue wiring at both
      restock call sites). Full integration suite (147 tests) run three
      times to rule out flakiness given the scope of this feature — all
      green. Verified end-to-end over real HTTP with two real signed-in
      buyers on the same sold-out variant: one who'd already requested
      saw the confirmation message with no button; one who hadn't saw the
      real button; a guest saw the sign-in prompt.
- [x] **Admin payout recording** — confirmed `SellerLedgerEntry.settledAt`
      is read (`getSellerBalance`'s payable/settled split) but was NEVER
      written anywhere in this codebase — a permanent, real gap: every
      seller's "already paid out" figure has been silently stuck at zero
      forever, for every seller, since the settlement feature shipped.

      A real, deliberate distinction drove this feature's design, not an
      afterthought: `settledAt`'s own schema comment ties it to "a real
      payout mechanism" that "actually pays this entry" — i.e., real money
      movement via SantimPay's B2C endpoint, the same already-flagged,
      correctly-out-of-scope risk as refunds. Building "mark as settled"
      as if the SYSTEM had paid the seller would mean fabricating a
      financial fact, the same category of problem already avoided this
      session for shipping-label tracking numbers. What's actually built
      instead: `recordSellerPayout` records that the ADMIN has ALREADY
      sent the money through their own real, off-system process (bank
      transfer, mobile money) — an attestation of a real action a trusted
      internal user performed, not the system claiming to have executed a
      payment. The Server Action, UI copy, and confirmation dialog are all
      deliberately explicit about this distinction ("record a payout you
      already made" / "this does not send any payment itself").

      Settles a seller's ENTIRE current payable balance atomically, not a
      partial amount — matches how an early-stage marketplace's real
      payout process actually works, and avoids the real complexity a
      partial-settlement UI would need for a v1 that doesn't need it yet.
      A seller whose ledger nets to zero or negative (return refunds
      outweighing sales right now) is correctly excluded from the queue,
      not shown as "owed 0"; recording a payout for a seller with nothing
      owed is rejected, not a silent no-op; a second payout call right
      after the first is rejected too — a balance can never be recorded
      as paid twice. New `/admin/payouts` page — every seller with a real
      outstanding balance, real amount owed, one button. 5 new integration
      tests (its own global, cross-seller query gets the same
      find-my-own-unique-row treatment `getBusinessMetrics` already
      established, not the array-length assertions that would carry the
      same real cross-file interference risk under `node --test`'s
      concurrent execution). Full integration suite (152 tests) run three
      times — all green. Verified end-to-end over real HTTP: a real
      seller's real owed amount (299.70 ETB, computed from a real sale
      minus real 10% commission) rendered exactly right; a guest is
      redirected to `/admin/login`.
- [x] **Customer order cancellation** — confirmed absent from the customer
      side (zero matches anywhere), even though `state-machine.ts` had
      declared `PENDING_PAYMENT -> CANCELLED` and `PAID -> CANCELLED` as
      real, legal transitions since the very first version of this
      codebase. Nothing had ever exercised them from a customer action.

      Only legal while `Order.fulfilmentStatus` is still UNFULFILLED — the
      moment ANY seller has shipped ANY line, the customer must use the
      existing returns flow instead, which operates per-line rather than
      cancelling the whole order outright. A PAID order's reversal mirrors
      return-service.ts's own REFUND-ledger pattern exactly: the real
      SALE/COMMISSION entries stay immutable, a REFUND entry cancels out
      the net — and restocking a variant back from zero runs the SAME
      real back-in-stock check return-service.ts and listing-service.ts
      already trigger, verified directly with a waiting requester
      actually getting enqueued.

      A real, dangerous bug was caught by this feature's own integration
      test, not by inspection: the first draft used `state-machine.ts`'s
      `assertOrderTransition` as its guard, whose "from === to is a silent
      no-op" rule is correct for webhook reprocessing (a redelivered
      callback that already applied must never error) but wrong for a
      user-initiated action. On a SECOND cancel attempt against an
      ALREADY-cancelled order, `CANCELLED -> CANCELLED` short-circuited
      past that check without throwing, and the atomic conditional update
      further down (which only verifies status hasn't changed since the
      read, not which status it legitimately started from) happily
      "reaffirmed" the same status and proceeded to double-restock real
      inventory. Fixed with an explicit status allowlist before the
      transaction even opens, replacing the state-machine helper entirely
      for this path. The "cancel twice" test failed against the original
      code and passes against the fix — the bug was real, not
      hypothetical.

      New `CancelOrderButton` on `/account/orders/[orderNumber]`, shown
      only when the order is genuinely still cancellable — gated on both
      `Order.status` and `Order.fulfilmentStatus`, matching the service's
      own two real checks rather than a looser client-side guess. 6 new
      integration tests. Full integration suite (158 tests) run three
      times given this touches the payment-critical order/inventory/
      settlement path — all green. Verified end-to-end over real HTTP: a
      genuinely cancellable order shows the button; an already-shipped
      order (same buyer, real FULFILLED order) correctly does not.

- [x] **Guest order lookup** — confirmed the site footer's "Help" column had
      shipped `<p>Order lookup</p>` as inert, unlinked text since the very
      first version of the footer — a promise with nothing behind it.

      A guest checkout has no session/account to scope an order to, so the
      real credential this uses is the same pair every comparable
      guest-tracking flow uses (eBay, Amazon guest checkout): order number +
      the email address entered at checkout. `get-order-status.ts`'s own
      existing comment already established that a bare order number
      (Crockford Base32) is "hard to guess, not a secret" on its own — email
      pairing is what keeps a guessed or intercepted order number from
      being a full line-item/address lookup all by itself.

      `getOrderForGuestLookup(orderNumber, email)` returns `null`
      indistinguishably for BOTH "no such order" and "right order, wrong
      email" — the same ownership-scoped discipline used everywhere else in
      this codebase, so the page can never be used as an email-enumeration
      oracle. New public, read-only `/track` page (GET query params,
      bookmarkable, matching `/search`'s own convention) showing line
      items, fulfilment/return status per line, the full price breakdown,
      and payment status — deliberately does NOT expose cancel/return
      actions, since both `cancelOrder` and `requestReturn` are keyed on a
      real `userId` a guest session doesn't have; the page instead prompts
      sign-in/register with the same email to manage the order further, a
      correct v1 scope rather than a half-built guest-auth workaround.
      Footer's "Order lookup" is now a real `<Link href="/track">`.

      5 new integration tests: matching pair returns the order; wrong email
      on a real order number returns null; nonexistent order number returns
      null; case/whitespace-tolerant email matching; empty inputs short-
      circuit without querying. Full regression suite (72 unit, 163
      integration) and a production build all pass. Verified end-to-end
      over real HTTP against a live server with a real seeded order: footer
      renders a genuine `<a href="/track">`; the bare form page shows no
      false "not found" state; a correct pair renders the order number,
      product title, and exact price (123.45 ETB); a wrong email on the
      same real order number renders only the generic not-found message
      with zero order data leaked; a nonexistent order number renders the
      same not-found message.

- [x] **Admin-assisted password reset** — confirmed a real, critical, and
      permanent gap: this codebase has real email/password auth
      (auth-service.ts, scrypt-hashed, real sessions) but never had ANY way
      back in for a user who forgets their password. Every forgotten
      password has been a permanent lockout since registration first
      shipped.

      A standard self-service "email me a reset link" flow cannot be
      honestly built here: notification-service.ts's own comment already
      establishes that no real email/SMS provider credentials exist in
      this system, so every "notification" it sends is in-app-only —
      useless for password recovery specifically, since the whole point is
      reaching a user who by definition cannot sign in to see an in-app
      notification. Fabricating a "reset email sent" claim when nothing
      was actually sent would mean presenting fake functionality as real,
      the same category of problem already avoided this session for
      carrier tracking numbers and automated seller payouts.

      What's built instead, matching `recordSellerPayout`'s established
      precedent for a real gap blocked on a missing external gateway: a
      trusted admin, having verified the request through their own real,
      off-system channel (a support ticket, a phone call), issues a real,
      single-use, time-limited (1 hour) token via a new `/admin/users`
      directory (itself a real, separate, confirmed gap — zero admin
      visibility into the users table existed before this) and relays the
      resulting link to the user themselves. The system never claims to
      have sent anything — the admin UI copy says so explicitly, twice
      (the confirm dialog and the one-time reveal itself).

      New `PasswordResetToken` model follows session.ts's own hash-only-
      stored discipline exactly: the raw token exists only for the instant
      it's generated, returned once in the Server Action's response, and
      in the URL itself — the database only ever sees its SHA-256.
      Redeeming a token (`/reset-password/[token]`, public) is a real
      security-sensitive path: rejects an unknown, already-used, or
      expired token with a specific message (not an enumeration risk here,
      since the token itself is already a high-entropy secret you must
      already possess to get any of these responses); issuing a NEW token
      for a user immediately invalidates any earlier unused one, so old
      links can never quietly pile up as standing account-takeover
      vectors; and — the one property that mattered most — a successful
      reset destroys EVERY existing session for that user, including one
      an attacker who caused the lockout might already hold, not just the
      browser that completed the reset.

      7 new integration tests, all passing, proving each of the above
      directly (old password stops working / new one works; every session
      destroyed; a token redeems exactly once; expired and unknown tokens
      rejected; a second issuance invalidates the first; issuing for a
      nonexistent user is rejected). Full regression suite (72 unit, 170
      integration) and a production build both pass. Verified end-to-end
      over REAL HTTP, including replicating Next's actual no-JS Server
      Action form-POST protocol with curl (multipart body carrying the
      `$ACTION_*` fields scraped from the real rendered page) rather than
      calling the service layer directly for the HTTP leg: a real admin
      login, a real `/admin/users` search finding a real seeded user, the
      real "Issue password reset link" action executed via that exact
      POST protocol and returning a real one-time link in the response
      body, that link's page correctly resetting the real password in the
      database (old password verified to stop working, new one verified
      to work), and reusing the same token afterward correctly rejected
      with "this reset link has already been used" rendered on the page.
      An unauthenticated request to `/admin/users` correctly redirects to
      `/admin/login`. Login page now points a locked-out user toward
      support rather than offering no path at all.

- [x] **Self-service password change** — confirmed absent alongside the
      admin-assisted recovery flow above: an already-signed-in user who
      simply wants to rotate their password (not locked out, just wants
      to change it) had no path either. Unlike account recovery, this one
      needs no external email delivery at all — the user is already
      authenticated, so it's fully self-service and was built completely,
      no honest-scoping workaround needed.

      `changePassword(userId, currentPassword, newPassword)` in
      auth-service.ts, alongside `register`/`login`: verifies the REAL
      current password first (a session being open must not be enough on
      its own to silently rotate the credential — the same reasoning a
      bank or GitHub applies), then hashes and sets the new one. On
      success it calls the exact same `destroyAllSessions` used by
      password-reset-service.ts's recovery flow — changing the password
      kills every existing session, this one included, and the user
      re-authenticates via a fresh login. No enumeration concern applies
      here the way it does in `login()`: the caller already proved who
      they are via a real session before this ever runs.

      New `/account/security` page and `ChangePasswordForm`, linked from
      the account page. 3 new integration tests (correct current password
      really rotates the hash; a wrong current password is rejected and
      changes nothing; a successful change destroys every session). Full
      regression suite (72 unit, 173 integration) and a production build
      pass. Verified end-to-end over real HTTP with the same Server-Action
      form-POST replication technique as the reset flow: a real customer
      login, a wrong-current-password attempt correctly rejected, a real
      successful change, and then — the strongest possible proof of the
      session-kill property — the SAME cookie that made the change request
      immediately redirected to `/login` on its very next request rather
      than reaching `/account`. A fresh login with the new password was
      then confirmed to work.

- [x] **Trust & safety: admin customer suspension** — confirmed a real
      gap: `Seller.status` already has a working suspend/reinstate flow,
      but a marketplace's other trust & safety lever — stopping an
      individual abusive CUSTOMER (fraud, chargebacks, harassment in
      reviews/Q&A) — had zero enforcement anywhere. An admin had no way to
      stop a bad-faith buyer from placing another order or logging back
      in at all.

      New `User.suspendedAt`/`suspendedReason`/`suspendedByAdmin` follow
      the exact same nullable-timestamp-as-status convention already used
      throughout this schema (`Order.cancelledAt`,
      `SellerLedgerEntry.settledAt`, `PasswordResetToken.usedAt`) rather
      than a new enum, since this is a plain binary state — and are
      deliberately independent of `Seller.status`: suspending a user's own
      standing doesn't touch whether their storefront (if they have one)
      stays live.

      `suspendUser`/`reinstateUser` in auth-service.ts, scoped to
      CUSTOMER-role accounts only (suspending STAFF/ADMIN through this
      same simple flow is deliberately not offered — a more sensitive
      action this v1 doesn't build a UI for). Suspending kills every
      existing session immediately via the same `destroyAllSessions`
      already used by the password-reset and password-change flows — not
      just future logins. `login()` now rejects a suspended account, but
      only AFTER the password has already been verified correct — the
      same reasoning `adminLoginAction`'s existing "you don't have admin
      access" message already relies on: revealing suspension here isn't
      an enumeration risk, since whoever just typed the right password
      already knows the account exists.

      New Suspend/Reinstate controls on `/admin/users/[id]` (shown only
      for CUSTOMER accounts) and a Status column on the `/admin/users`
      list. 8 new integration tests covering `suspendUser`/`reinstateUser`
      directly (session-killing, double-suspend rejected, role-scoping,
      reinstate clearing cleanly, reinstating a non-suspended account
      rejected). The one property that genuinely needs a real Next.js
      request context — `login()`'s actual rejection of a suspended
      user — can't run under the plain test runner (same
      `next/headers`-outside-the-pipeline limit session-store.ts's own
      comment already documents for the worker), so that property was
      verified via real HTTP E2E instead: a real customer logging in
      successfully before suspension, suspended via the (already fully
      integration-tested) service layer, the SAME correct password then
      genuinely rejected with the exact suspension message, the admin
      `/admin/users` list and detail pages correctly reflecting
      "Suspended" with the real reason, the real `reinstateUserAction`
      submitted via Next's actual Server Action form-POST protocol over
      curl (proving the admin-facing wiring, not just the service
      function), and login working again immediately afterward with no
      change to the password. (The mirror-image `suspendUserAction`
      button reveals its reason field via client-side state, so its exact
      HTML never appears in a plain curl fetch the way the unconditional
      forms elsewhere on this page do — that action was exercised via the
      service layer directly for the E2E pass rather than reshaping the
      UI just to ease testing; it shares 100% of its scaffolding with the
      real-HTTP-proven `reinstateUserAction` in the same file.)

      Full regression suite (72 unit, 178 integration) and a production
      build both pass.

- [x] **Bug fix: recently-viewed ordering was still wrong under CI, not just
      "flaky"** — CI went red on the customer-suspension push with a real,
      reproducible assertion failure in
      `recently-viewed-service.integration.test.ts`, in a test unrelated to
      that push (it hadn't been touched this session since the original
      "Recently viewed products" entry above). The earlier fix for that
      feature — order by `[viewedAt desc, id desc]`, reasoning that `id`
      (a cuid) breaks a millisecond-precision tie — was itself wrong, not
      just occasionally unlucky: an upsert's UPDATE branch never changes a
      row's `id`. So a product viewed long ago (smaller id), then
      RE-viewed just now, can still lose a `viewedAt` tie against a
      DIFFERENT product's row created more recently (larger id) but never
      re-viewed since — exactly backwards from "most recently viewed
      first". `id` tracks *when a row was first created*, never *when it
      was last touched* — a real design error in the original fix's
      reasoning, not a coincidence of bad luck, and CI's 3-job-parallel
      timing made the millisecond tie land more often than it happened to
      locally.

      Root-caused rather than patched: replaced the whole `viewedAt`/`id`
      ordering scheme with a real, DB-level monotonic counter.
      `RecentlyViewed.touchSeq` (`BigInt`) is bumped via a Postgres
      sequence's `nextval()` on EVERY view — create or update alike, via a
      raw `UPDATE ... SET "touchSeq" = nextval(...)` run in the same
      transaction as the upsert — so ordering is correct regardless of
      timestamp precision or which row is older. `listRecentlyViewed` now
      orders by `touchSeq` alone.

      New direct regression test asserts the exact invariant: after
      viewing A, then B, then re-viewing A, A's row id is confirmed
      smaller than B's (proving the old scheme's precondition for failure
      is real) while A's `touchSeq` is confirmed greater (proving the fix).
      Full integration suite (179 tests) run 3 times clean — this file's
      own tests run 5 times clean in isolation first. Verified end-to-end
      over real HTTP through the ACTUAL product-page write path, not a
      pre-seeded row: visited product A, then B, then re-visited A as a
      real signed-in customer, and confirmed the homepage's "Recently
      viewed" section rendered A before B in both the real HTML and its
      RSC flight duplicate. Full regression suite (72 unit, 179
      integration) and a production build pass.

- [x] **Seller self-service storefront settings** — confirmed a real gap:
      `storeName`, `description`, and `logoUrl` all exist on the `Seller`
      model but were only ever set ONCE, at application time
      (`applyToBecomeSeller`) — an approved seller had no way to update
      their own public-facing profile ever again. `logoUrl` specifically
      was doubly dead: not just uneditable, but never even rendered
      anywhere — set at signup, displayed nowhere, forever.

      New `updateSellerProfile(sellerId, {...})` in seller-service.ts.
      `slug` is deliberately NOT editable — it's the store's real URL
      (`/sellers/[slug]`), and changing it would break every existing
      link/bookmark, the same "URLs are permanent identifiers" reasoning
      already applied to product/order slugs elsewhere in this codebase.
      No format validation on `logoUrl` beyond trimming, matching this
      codebase's equally lightweight existing `imageUrl` handling for
      products — there's no real upload pipeline for either, both are
      plain pasted URLs. New `updateSellerProfileAction` follows this
      session's own established discipline: calls `requireApprovedSeller`
      itself rather than trusting the page gate, and never trusts a
      client-supplied sellerId — it's always the caller's own seller
      record. New `/sell/settings` page, linked from the seller dashboard.
      Also wired the previously-dead `logoUrl` into the actual public
      storefront page next to the store name, since building "edit a
      field nothing ever displays" would have been half a feature.

      3 new integration tests (trims and applies real updates; blank
      input clears description/logoUrl to null rather than leaving stale
      values; a too-short store name is rejected and changes nothing).
      Full regression suite (72 unit, 182 integration) and a production
      build pass. Verified end-to-end over real HTTP: the storefront page
      showing the original name/description with no logo, a real signed-
      in seller submitting a real profile update via Next's actual Server
      Action form-POST protocol, the storefront then showing the new
      name/description/logo with the old name gone, and the store's slug
      (its real URL) confirmed unchanged in the database throughout.

- [x] **Order delivery notes** — confirmed a real, half-built gap:
      `Order.customerNote` already existed on the schema and
      `checkout-service.ts`'s `PlaceOrderInput`/`placeOrder` already
      accepted and persisted it — but NOTHING ever collected one: no
      textarea on the checkout form, and `checkout-actions.ts`'s
      `submitCheckout` never even read a `customerNote` value from the
      submitted FormData to pass through. The field was write-capable but
      permanently fed `undefined`. Nothing displayed it either — not to
      the seller preparing to ship, not to admin, not back to the
      customer themselves. The exact same "field exists, never wired"
      shape as `Seller.logoUrl` before this session's seller-settings fix.

      Added a "Delivery notes" textarea to the checkout form (500 char
      cap, matching the same cap enforced server-side in
      `submitCheckout`), wired it through to the existing
      `placeOrder`/`Order.customerNote` write path, and surfaced it
      everywhere an order is actually reviewed: the seller's order detail
      page (`getSellerOrderDetail`'s select needed the field added), the
      admin order detail page (already selected via `include`, just never
      rendered), the customer's own account order page, and the guest
      order-lookup page — all four read paths already had the field
      available via `include`/an added `select`, so this was purely
      display wiring plus the two collection-path fixes.

      No new integration test: `customerNote`'s handling is a one-line,
      non-branching passthrough (`customerNote: input.customerNote`,
      identical in shape to the pre-existing, untouched `landmark` field
      right next to it), and this file's own test file
      (`checkout-service.integration.test.ts`) already documents, from an
      earlier session, why a full happy-path `placeOrder()` call isn't
      exercised here: it requires `env()` to validate a complete
      SantimPay config this environment deliberately does not carry.
      Verified instead by the same discipline applied elsewhere when a
      full DB-level test isn't practical: thorough real HTTP E2E. Full
      regression suite (72 unit, 182 integration — unchanged counts, a
      real confirmation nothing regressed) and a production build pass.
      Verified end-to-end over real HTTP: the checkout form (reached via
      a real seeded cart, not a pre-filled mock) rendering the new
      textarea; a real seeded order's note showing correctly on all four
      read surfaces — guest lookup, the customer's own account page, the
      seller's order detail page, and the admin order detail page — each
      reached via its own real signed-in session where one was needed.

- [x] **Seller low-stock alerts, and a real "only N left" bug fix** —
      confirmed `Inventory.lowStockThreshold` already existed, with its own
      schema comment promising "the storefront shows 'only N left'" — but
      was completely unused: the storefront hardcoded its own `<= 5`
      instead of reading it, and no seller-facing low-stock notification
      existed anywhere (every prior `notifyX` in notification-service.ts
      targeted a customer; sellers had zero proactive signal that their
      own stock was running out). The same "field exists, comment
      promises behavior, nothing wired" shape as `Seller.logoUrl` and
      `Order.customerNote` earlier this session — the third instance of
      this exact bug class found this run.

      Fixed both halves. Customer-facing: the product page now threads
      the REAL per-variant `lowStockThreshold` through to
      `add-to-cart-form.tsx`'s stock note instead of a fixed number —
      verified with a real, deliberately-chosen case (8 available, a
      seller-set threshold of 10) that the OLD hardcoded logic would have
      gotten wrong (8 > 5 would have shown "In stock"; the fix correctly
      shows "Only 8 left"). Seller-facing: `lowStockThreshold` is now a
      real, editable field on the variant-edit row (`updateVariant`), and
      a new `low-stock-service.ts` — `enqueueLowStockCheck` — mirrors
      back-in-stock-service.ts's own architecture but simpler (no
      per-recipient request row; a seller doesn't opt in to hearing about
      their own stock). Wired into the same transaction as every real
      inventory-decreasing write: `payment-service.ts`'s
      `commitReservations` (a real committed sale — the meaningful
      signal, unlike a still-reversible HELD reservation) and
      `listing-service.ts`'s `updateVariant` (a seller's own manual
      correction, whether to stock or to the threshold itself).

      Re-arm design deliberately mirrors BackInStockRequest's own
      `notifiedAt`/`notificationCount` fix from earlier this session — new
      `Inventory.lowStockAlertedAt` (cleared on recovery, re-arming for
      the next real dip) and `lowStockAlertCount` (monotonic, NEVER
      reset, feeding the notification's dedupeKey) — for the identical
      reason: resetting the wrong field on recovery would let a later
      alert collide with an earlier cycle's already-delivered
      notification and be silently swallowed. New `NotificationType.
      LOW_STOCK` and `notifyLowStock` — this module's first ever
      SELLER-facing notification, not customer-facing.

      13 new integration tests: 5 for `enqueueLowStockCheck` (healthy
      no-op, fires once per real dip not once per unit sold while already
      low, the exact re-arm-after-recovery scenario proven with a real
      second alert and a real distinct dedupeKey-feeding count, and a
      genuinely custom per-variant threshold respected), 2 for
      `notifyLowStock` (targets the real seller owner, dedupeKey
      correctly distinguishes a redelivered event from a genuine second
      alert), 1 for `updateVariant`'s new threshold-setting and check-
      triggering. Full regression suite (72 unit, 190 integration, run
      twice clean given this touches the payment-critical inventory path)
      and a production build pass.

      Verified end-to-end over real HTTP: the product page showing "Only
      8 left" for a real seeded 8-available/threshold-10 variant (the
      exact case the old hardcoded logic got wrong); the seller's product-
      edit page rendering the real current threshold in a real input; a
      real threshold change submitted via Next's actual Server Action
      form-POST protocol immediately flipping the customer-facing message
      correctly; and a real HTTP-triggered stock update that crossed
      below the new threshold producing a real, correctly-shaped message
      in the actual outbox table. The one link deliberately not exercised
      over HTTP — the worker process actually delivering that outbox
      message — needs the same real SantimPay env config this environment
      doesn't carry (worker/index.ts calls `env()` unconditionally at
      startup, same blocker already documented for `customerNote`'s
      checkout path this session); that link is instead fully covered by
      `notifyLowStock`'s own 2 integration tests, calling the real
      function against a real Postgres.

- [x] **Compare-at ("sale") pricing, plus a systematic sweep for more dead
      fields** — after finding THREE separate "field exists, nothing
      wired" bugs this session (`Seller.logoUrl`, `Order.customerNote`,
      `Inventory.lowStockThreshold`), audited systematically rather than
      waiting to stumble onto more: extracted every model field from
      schema.prisma and grepped its real usage count across `src/`.
      `Variant.compareAtSantim` — a real, pre-existing field with its own
      comment ("Original price for strike-through display") — came back
      at ZERO usages anywhere outside the schema itself. The fourth
      instance of this exact bug class this session.

      Fixed both halves, the same shape as the `lowStockThreshold` fix:
      write side (`addVariant`/`updateVariant` now accept a real,
      optional `compareAtBirr`, validated to be genuinely higher than the
      actual price — rejects a backwards "sale" that would show a
      struck-through price LOWER than what's actually charged, both at
      creation and when a price change and a compare-at change land in
      the same submission, checked against whichever price will actually
      be in effect afterward) and read side (the product page now shows
      a real struck-through "was" price next to the current one, only
      when set and genuinely higher). Deliberately scoped to the PDP,
      not the grid `ProductCard` — that would need deciding which
      variant's compare-at to show for a "from" price aggregated across
      several, a real added complexity kept out of this pass.

      Also swept the audit's other findings for triage: `metaTitle`/
      `metaDescription` are genuinely read (product page's own
      `generateMetadata`) but have no write path either — a smaller,
      real gap noted for a future pass, not fixed here to keep this one
      focused. `User.emailVerifiedAt` is confirmed dead but correctly
      OUT of scope, same reasoning as self-service password reset:
      verifying an email's realness is the one thing an admin-assisted
      workaround structurally cannot substitute for.

      2 new integration tests (accepts a real higher compare-at and
      rejects a backwards one at creation; sets then clears one via a
      blank submission, and validates against the correct in-effect
      price when price and compare-at change together). Full regression
      suite (72 unit, 192 integration) and a production build pass.
      Verified end-to-end over real HTTP: a real seeded 80/120 ETB
      price/compare-at pair rendering the correct strike-through; the
      seller's product-edit page showing the real current value; a real
      update to 150 ETB via Next's actual Server Action protocol
      immediately reflected on the customer-facing page; and a real
      backwards (50 ETB compare-at against an 80 ETB price) submission
      correctly rejected with the database confirmed unchanged.

- [x] **SEO title/description write path — the fifth dead field this
      session** — the compare-at entry above already flagged this one:
      `Product.metaTitle`/`metaDescription` were genuinely read (the
      product page's own `generateMetadata` already fell back to
      `title`/`subtitle` when unset) but had NO way for a seller to ever
      set them — `CreateProductInput`/`UpdateProductInput` simply didn't
      have the fields. Closing this out now that compare-at pricing
      shipped clean.

      Added to `updateProduct` only, not `createProduct` — the same
      "not at initial creation, only as an ongoing refinement" scoping
      already applied to `lowStockThreshold` and `compareAtBirr`: SEO
      copy is something a seller tunes once they see the listing live,
      not something worth a field on the first-draft form. Blank input
      clears back to null (the fallback), not a no-op — matches every
      other optional-text-field convention already established this
      session (`updateSellerProfile`, `updateVariant`'s `compareAtBirr`).
      New "Search appearance" section on the product-edit form.

      1 new integration test (sets and trims real values, then clears
      them back to null via a blank submission). Full regression suite
      (72 unit, 193 integration) and a production build pass. Verified
      end-to-end over real HTTP: the baseline `<title>` tag falling back
      to the product's own title before any SEO override; a real seller
      submitting a real SEO title/description via Next's actual Server
      Action protocol; the product page's `<title>` and
      `<meta name="description">` tags immediately reflecting the real
      submitted values; and a follow-up blank submission correctly
      reverting the `<title>` tag back to the fallback. (One real,
      useful diagnostic detour along the way: the first two submission
      attempts appeared to silently do nothing under a naive HTML-text
      check for a rendered error banner — the actual cause, found by
      reading the RSC payload's own embedded state object directly, was
      a genuinely working, pre-existing, UNRELATED validation rejecting
      the seed script's 1-character placeholder description. Once
      corrected to a real ≥10-character description, the update — and
      the error path's own real correctness — were both confirmed.)

- [x] **Self-service account deletion** — completes the account-lifecycle
      story this session already built most of (admin-assisted recovery,
      self-service password change, admin suspension): a user could
      change or recover their password and an admin could suspend them,
      but there was no way for a user to actually leave — a real,
      standard right on virtually every comparable platform, confirmed
      genuinely absent (zero matches for delete/anonymize anywhere).

      Anonymizes rather than hard-deletes — the same reasoning
      `OrderLine`'s own snapshotted fields already establish: a real
      `DELETE` on `User` would cascade or orphan unpredictably across
      every relation this table touches, corrupting real financial/order
      history. `Order.email`/`phone` are their OWN independent snapshot
      from checkout, already captured separately from `User.email` — so
      anonymizing the account touches zero past orders' own contact info,
      and no separate "has pending orders" guard was needed on the buyer
      side. The seller side is different and IS guarded: an APPROVED
      seller has a real, live storefront other people are actively
      transacting with — deleting that account out from under it would
      strand real customers, so it's refused; a PENDING/REJECTED/
      SUSPENDED seller has no live obligation and may delete freely.

      New `User.deletedAt`, deliberately a SEPARATE field from
      `suspendedAt`, not a reused one — suspension is temporary,
      admin-imposed, and reversible (a real `reinstateUser` exists);
      deletion is permanent and user-initiated, and must never look
      "reinstatable" the same way. The login-block itself needs no new
      check at all: `deleteOwnAccount` also nulls `passwordHash`, and
      `login()`'s own pre-existing `!user.passwordHash` branch already
      rejects with the exact same generic "Incorrect email or password"
      a wrong password gets — the identical enumeration-prevention
      reasoning already documented there, now covered for free. Email is
      rewritten to `deleted-<userId>@deleted.invalid` — `.invalid` is the
      real IANA-reserved TLD for exactly this, not an improvised
      convention — freeing the original address for a genuine future
      re-registration. Requires re-confirming the current password first,
      matching `changePassword`'s own precedent that an open session
      alone isn't enough to authorize a permanent, destructive action.

      New "Danger zone" section on `/account/security`, alongside the
      password form. Admin's `/admin/users` list and detail pages now
      distinguish Deleted from Suspended from Active, and the detail page
      correctly hides the now-meaningless password-reset-issuance and
      suspend/reinstate controls for a deleted account rather than
      offering buttons that would act on an anonymized row with no real
      owner.

      6 new integration tests (anonymizes and permanently blocks login;
      wrong password rejected and changes nothing; destroys every
      session; a second delete attempt rejected; an APPROVED seller
      blocked; a PENDING seller's account deletes freely). Full
      regression suite (72 unit, 199 integration) and a production build
      pass. Verified end-to-end over real HTTP: the Danger zone
      rendering; a wrong-password attempt rejected; an APPROVED seller's
      attempt correctly refused with the database confirmed unchanged; a
      real successful deletion via Next's actual Server Action protocol
      redirecting home; the anonymized email/null name/null phone/null
      passwordHash/set deletedAt all confirmed in the database; the exact
      cookie that made the deletion request dead on its very next
      request; a fresh login attempt with the original credentials
      genuinely rejected with the same generic message a wrong password
      gets; and the admin list/detail pages correctly showing "Deleted"
      with the recovery/suspension controls hidden.

- [x] **Related products ("more from this seller")** — confirmed absent:
      zero matches anywhere for related/similar/cross-sell. A real,
      standard e-commerce feature this marketplace had no version of at
      all — a customer finishing a product page had no path to discover
      anything else, even from the SAME seller they were already
      considering buying from.

      Deliberately the simplest correct definition, not a fabricated
      recommendation engine: other currently-visible products from the
      same seller, the same framing comparable marketplaces (Etsy, eBay)
      already use for exactly this, rather than pretending to a
      collaborative-filtering signal this app has no real data to back.
      New `listRelatedProducts(sellerId, excludeProductId, take)` reuses
      the exact same `VISIBLE_PRODUCT_WHERE` visibility rule every other
      browsing query in catalogue-service.ts already enforces — a
      suspended seller's or an unpublished listing's other products
      correctly never appear. New section on the product page, reusing
      the existing `ProductCard` grid component (same wishlist-button
      wiring already established for every other product grid this
      session), hidden entirely rather than shown empty when a seller
      has no other visible listings.

      First dedicated test coverage for catalogue-service.ts at all — 5
      new integration tests (excludes the product itself; never crosses
      seller boundaries; excludes a DRAFT sibling; excludes every
      listing once the seller is suspended; respects the take limit).
      Full regression suite (72 unit, 204 integration) and a production
      build pass. Verified end-to-end over real HTTP: a real product
      page showing two real sibling listings from the same seller under
      "More from [Seller]", a third, unrelated seller's product
      confirmed absent from that section, and the section confirmed
      fully hidden (not shown empty) for a seller with no other
      listings. (Noted, not fixed here, to keep this pass focused:
      `ProductCard`'s own "Low stock" badge is STILL hardcoded to `<= 5`
      rather than reading `Inventory.lowStockThreshold` — the same bug
      class already fixed on the PDP's stock note earlier this session,
      not yet fixed on the grid card because aggregating across several
      variants with potentially different thresholds needs a real design
      decision, the same complexity already deferred for compare-at
      pricing's own grid-card display.)

- [x] **ProductCard "Low stock" badge now reads the real threshold** — the
      queued item from the related-products entry above: fixed the same
      hardcoded-`<= 5` bug already fixed on the PDP's stock note, this
      time on the grid card. Aggregates across a product's variants using
      the MAX real `lowStockThreshold` among them (the most conservative
      real setting — the badge fires as soon as any one variant's own
      threshold would). Full regression suite (72 unit, 204 integration)
      and production build pass. Verified over real HTTP with the same
      deliberately-chosen case as the PDP fix (8 available, threshold 10)
      — correctly shows "Low stock" where the old hardcoded logic would
      have shown nothing.

- [x] **Admin audit log** — confirmed absent (no `AdminAuditLog`/`AuditLog`
      model) despite this session having accumulated real, sensitive
      admin power across two files with no unified, persisted trail:
      suspend/reinstate a customer, issue a password reset, record a
      payout, approve/reject/suspend a seller, change commission, feature
      a product, resettle a payment. A few of these already had a
      per-entity field (`Seller.reviewedBy`, `User.suspendedByAdmin`) but
      nothing unified them, and most had no persisted trail at all — only
      a structured log line, not a queryable database record.

      New `AdminAuditLog`, deliberately mirroring two precedents already
      established in this schema: `actorUserId` is a plain string, not a
      relation (same reasoning `OrderEvent.actor`/`Seller.reviewedBy`
      already use — the admin's account outliving every action they took
      is not a DB-level constraint worth enforcing), and `actorEmail` is
      a REAL snapshot, not a live join — the same reasoning `OrderLine`
      snapshots product/seller data, made concretely necessary by this
      session's own self-service account deletion: an admin's email can
      now be anonymized by that same admin, with no role restriction, and
      the trail must keep saying who really did this at the time.

      `recordAdminAction`/`listAuditLog` in a new `audit-log-service.ts`,
      wired into all 10 real admin actions across `admin-actions.ts` and
      `seller-actions.ts` (three of which — `resettlePaymentAction`,
      `toggleProductFeaturedAction`, `recordSellerPayoutAction` — were
      previously discarding their own `requireRole` return value entirely,
      never even capturing the acting admin; fixed as part of wiring
      this in). New `/admin/audit-log` page (filterable by target type),
      linked from the sidebar nav, plus a direct "View audit log for this
      user" cross-link from `/admin/users/[id]`.

      3 new integration tests for the service itself, most notably one
      proving the snapshot property directly: an entry's `actorEmail`
      survives, unchanged, after that same admin's `User` row is
      anonymized exactly the way `deleteOwnAccount` would do it. Full
      regression suite (72 unit, 207 integration) and a production build
      pass. Verified end-to-end over real HTTP: a real admin login, a
      real `reinstateUserAction` submitted via Next's actual Server
      Action protocol, and the resulting entry immediately visible on
      both the target-filtered and the general `/admin/audit-log` views
      with the correct admin email — and the page itself confirmed
      blocked for an unauthenticated request. (The other 9 wiring sites
      share this exact same simple, mechanical pattern — call
      `recordAdminAction` with the same shape right after the real
      action succeeds — and weren't each independently re-verified over
      HTTP; the service layer's own 3 tests plus this one full round
      trip cover the pattern's correctness.)

- [x] **Product Q&A moderation** — confirmed absent (review moderation
      already existed via `hideReview`/`unhideReview`, but Q&A had no
      equivalent): an inappropriate question had no way to be removed by
      anyone. New `ProductQuestion.hiddenAt`, `hideQuestion(sellerId, …)`
      mirroring `answerQuestion`'s own ownership scoping exactly (ability
      to remove a question on their OWN product, indistinguishable
      "not found" for a cross-seller attempt). Hidden questions excluded
      from both the public PDP list and the seller's own reply queue.
      New "Remove question" button on `/sell/questions`. Deliberately v1
      scope: wired onto the unanswered-questions queue only, not a
      separately already-answered view — an already-answered question
      needing retroactive removal isn't covered by this UI yet.

      2 new integration tests (removes from both the public list and the
      seller's queue; seller-scoped, a cross-seller attempt indistinguish-
      able from not found). Full regression suite (72 unit, 209
      integration) and a production build pass. Verified end-to-end over
      real HTTP: a real question visible on the PDP, a real seller
      removing it via Next's actual Server Action protocol, and the
      question confirmed gone from the public page immediately after.

- [x] **Self-service data export** — the natural companion to self-service
      account deletion, confirmed genuinely absent. New
      `exportUserData(userId)`, scoped entirely to the calling user's own
      id (profile, addresses, orders with lines, reviews, wishlist,
      questions asked). New `GET /account/data-export` Route Handler
      (mirrors `/sell/products/export`'s own established convention —
      `requireUser`, real `Content-Disposition: attachment`), a single
      JSON file. Linked from `/account/security`, including a pointer to
      it from the Danger zone copy ("consider downloading your data
      before you delete your account").

      1 new integration test proving the scoping property that matters
      most: another user's address/order/wishlist item never leaks into
      someone else's export. Full regression suite (72 unit, 210
      integration) and a production build pass. Verified end-to-end over
      real HTTP: a real signed-in user downloading a real JSON file with
      the correct headers and their own real profile/address data, and
      an unauthenticated request to the same route confirmed redirected
      to login.

- [x] **Seller order search/filter** — confirmed absent: `listSellerOrderLines`
      was capped at 100 with no way to search or filter at all, unlike
      admin's own `/admin/orders`. A seller with more than 100 sales had
      no way to find an older or specific one. New `SellerOrderFilter`
      (`search` — order number or buyer email; `fulfilmentStatus` — the
      LINE's own status, matching this schema's existing "per-line, not
      just per-order" fulfilment design). New search/filter form on
      `/sell/orders`, mirroring the admin orders page's own convention.

      2 new integration tests (search matches order number or buyer
      email, scoped to the calling seller only; filter matches the
      line's real fulfilment status). Full regression suite (72 unit,
      212 integration) and a production build pass. Verified end-to-end
      over real HTTP: two real seeded orders, confirmed both show
      unfiltered, confirmed search by order number and by buyer email
      each isolate the right one, and confirmed a fulfilment-status
      filter isolates the right one too.

- [x] **Customer order search** — same gap, buyer side: `getOrdersForUser`
      was unbounded but had no search at all. New `search` param matching
      either the order number or a line's product title ("the blue
      jacket" is often easier to remember than an order number), scoped
      to the calling user only. New search form on `/account`. First
      dedicated test coverage for this module — 1 new integration test
      proving both match paths and that another user's order never
      leaks in regardless of what's searched for. Full regression suite
      (72 unit, 213 integration) and a production build pass. Verified
      end-to-end over real HTTP: two real seeded orders, confirmed both
      show unfiltered, confirmed search by order number and by product
      title each isolate the right one, and a non-matching search
      correctly shows "No matching orders."

### Current status / where to resume (2026-08-21, commit `431e1d1`)

Every checklist item above is `[x]`. All work through this commit is
pushed to `main` with CI confirmed green — not just triggered, actually
watched to a real, uncontested completion, per this session's own working
discipline above. Full regression suite (typecheck, lint, 72 unit, 213
integration) and a production build all pass cleanly as of this commit.

Deliberately still out of scope, not oversights — both genuinely blocked
on real external state this environment doesn't have, not scoping
choices: **automated seller payouts** (sending actual money via
SantimPay's B2C payout endpoint carries the same unconfirmed-gateway-
semantics risk flagged for refunds — see `docs/01-santimpay-protocol-
spec.md`'s own open questions; what IS built is recording a payout the
admin already sent through their own off-system process — see the payout
entry above) and **real carrier shipping** (`carrier-client.ts` is an
explicit curriculum mock — `mock-carrier.example`, an in-memory ledger —
wiring its fake tracking numbers into real UI would mean presenting
fabricated data to real users, which was correctly not done this session
even though the `ShippingLabel` model and service layer already exist).
The same missing-email-infra reason blocks a **self-service** "email me a
reset link" password flow specifically — what IS built is the honest
admin-assisted alternative (see the password reset entry above); if real
email/SMS credentials are ever added to this environment, self-service
reset and real notification delivery become the natural next step for
both this feature and every existing in-app-only notification.

If continuing this mandate: the highest-value next step is another honest
gap audit against the master mandate's full feature list (the same method
that found every feature built this session — grep the codebase for what
a real marketplace needs, don't assume; several rounds of this already
found wishlist, notifications, seller coupons, product Q&A, bulk CSV
import/export, back-in-stock notifications, admin payout recording,
customer order cancellation, guest order lookup, admin-assisted password
reset, self-service password change, admin customer suspension, seller
self-service storefront settings, order delivery notes, seller low-stock
alerts, compare-at pricing, SEO title/description, self-service account
deletion, related products, the ProductCard low-stock badge fix, an
admin audit log, product Q&A moderation, self-service data export, seller order search/filter, customer order search, and
more, each confirmed genuinely absent before being built). No further
specific candidate is currently queued — the systematic dead-field
audit's one remaining finding, `User.emailVerifiedAt`, is confirmed dead
but correctly out of scope (see the compare-at entry above for why).
Gift cards / store credit was considered and
deliberately not pursued: unlike everything built this session, issuing
one would need a real payment-collection step, the same real-gateway-
confirmation complexity already blocking seller payouts, not a clean fit
for this session's "no external dependency" pattern. If a specific
feature is wanted instead, this file's own per-feature entries above show
the established pattern to follow: schema (checked for the real
searchVector migration hazard — see any entry above), service layer with
ownership scoping, Server Actions with in-action auth, real integration
tests, full regression, production build, real HTTP E2E verification,
then commit/push/watch CI to green before moving on.

## PRODUCTION-READINESS HISTORY (prior mandate, mostly complete)

Everything below this line documents the earlier "harden the existing
single-vendor app for production" effort. It is not obsolete — the CI/CD
pipeline, security headers, Docker hardening, chaos/load-test evidence,
and payment-correctness work it describes all still apply directly to the
marketplace transformation above (a marketplace still needs correct
payments, security headers, and a working CI pipeline) — but new work
should be tracked in the ROADMAP above, not appended here.

## CURRENT PHASE (historical — see MANDATE above for active work)

Phase 1 (Repository Sync) — complete. Phase 2 (Repository Audit) — complete,
two full passes (application-layer: dead code, payments, inventory,
authorization, secrets; infra-layer: DB schema, migrations, security headers,
rate limiting, container security, K8s manifests, Trivy ignore quality).
Phase 4 sub-slice (customer order visibility) — fixed. Phase 9 (Database
Integrity) — fixed (FK guardrails, missing indexes). Phase 11 (Security
Audit) sub-slices — fixed (response security headers, edge rate limiting,
container hardening). Phase 13 (Chaos Testing) — one real drill executed
with fresh evidence (checkout transaction atomicity under a killed DB
connection). Phase 14 (Observability) — dashboard-vs-metrics drift check
done, no drift found. Phase 15 (Performance) — 3 real k6 load tests
executed against a real production build (smoke, ramping browsing spike to
50 VUs, sustained 12-replica health-probe load) — see LOAD TEST RESULTS
below; one real, reproduced 503 finding turned out to be my own test-setup
error (missing env var), not an app bug, confirmed and documented as such.
Phase 16 (Docker) — fixed (dev-dependency pruning, HEALTHCHECK) and
validated with a real CI Docker build + Trivy scan. Phase 18 (CI/CD)
sub-slice (lint) — fixed. Phase 20 (Documentation) — root README added.
Phases 3, 5–8, 10, 12, 17, 19, 21 — not freshly re-walked this pass; see
NEXT ACTION.

## CURRENT GATE

All work through the items below is committed, pushed, and CI-confirmed
green on `origin/main`. Ready to continue into the remaining unwalked
phases, or to produce the final structured report if the remaining scope
is being deliberately deferred — see PRODUCTION READINESS STATUS.

## COMPLETED GATES (this execution pass, chronological)

1. Repo sync to `origin/main`, Dependabot PRs #1–8, #11–13 merged (9 total
   this pass), each verified via real passing CI before merge. PRs #9
   (Prisma 7), #10 (Next.js 16), #14 (TypeScript 7) left open by design —
   each a real, reproduced breaking migration, not a safe bump.
2. Real CVE fixed: `CVE-2026-40345` (deepmerge-ts), `e3652bb`.
3. Real test-flakiness bug fixed: order-number truncation, `3c0d597`.
4. `test:integration` fixed (`node --experimental-strip-types` → `tsx`),
   part of `b3498fe`.
5. Full Phase-2 application-layer audit (dead code, payments, inventory
   concurrency, authorization, secrets, test inventory) — all clean except
   one real gap found and fixed:
6. **`2408472`** — customer order-detail page (`/account/orders/[orderNumber]`),
   wiring up a previously-orphaned, correctly-scoped `getOrderForUser`.
   Verified via 5 real HTTP checks against a live session-backed dev
   server (golden path, cross-user 404, unauth redirect, nonexistent 404).
7. **`cbf2db4`** — lint gap closed. CI's own comment claimed "typecheck/lint"
   but no lint existed anywhere. Added real ESLint to both packages, fixed
   6 real pre-existing lint errors it surfaced.
8. **`15e55ca`** — this file's first version.
9. **`0fd48fd`** — `docs/release/PRODUCTION-RELEASE.md` created (self-corrected
   one wrong claim about a missing Grafana dashboard before shipping it —
   the dashboard is real and does track business-health metrics).
10. **`d05f771`** — security(web,k8s): a dedicated infra audit found ZERO of
    the standard OWASP security headers set anywhere, and no rate limiting
    at any layer despite app code assuming it exists at the edge. Added
    all 6 headers via `next.config.ts`, verified live on real HTTP
    responses. Split `ingress.yaml` into two Ingress resources so a real
    per-IP rate limit (20rps/burst5x) applies to everything except the
    SantimPay webhook path (deliberately exempt — signature verification
    is the real trust authority there). Caught and fixed a real bug in the
    first draft (paths were backwards) by actually rendering the overlay
    and inspecting it, not by assuming the edit was correct. Re-validated
    both overlays with kubeconform -strict: 17/17.
11. **`15ed895`** — fix(db): the same infra audit found all 4 of Order's
    Cascade children (OrderLine, OrderEvent, PaymentIntent, ShippingLabel)
    would be silently destroyed if an Order were ever hard-deleted — no
    code path does this today, but there was no guardrail either. Switched
    to Restrict (metadata-only, zero current-behavior change). Added 3
    indexes for real, confirmed query patterns that had none
    (orders(status,paidAt), payment_intents(status,createdAt),
    inventory_reservations(orderId,status)). Caught a real, direct
    consequence while re-running the suite: a test's own cleanup hook
    deleted Order before its ShippingLabel child, which Restrict now
    correctly refuses — fixed the cleanup ordering, not the constraint.
12. **`8539b5d`** — security(docker): same audit found no HEALTHCHECK and
    devDependencies (eslint, typescript, ~60MB) shipping in the production
    image. Fixing this correctly required first reclassifying `prisma`
    (the CLI) from dev to a real dependency — it's needed at runtime by
    the migrate role, which shares this image. Verified the actual prune
    command OUTSIDE Docker first (this sandbox's Docker daemon has no
    network egress): discovered `pnpm install --prod` alone does NOT
    shrink anything (only removes symlinks, leaves real bytes in
    `node_modules/.pnpm`) — `pnpm prune --prod` is the command that
    actually does. Booted the real production server against the pruned
    tree and got a real 200 with all security headers intact before
    trusting it in the Dockerfile. Then this exact Dockerfile was
    validated for real by CI's Docker build + Trivy scan job, which has
    genuine network access — both passed.
13. **`a31a199`** — docs: added the repository root README (a real, total
    gap — none existed).
14. **Real chaos drill executed** (not yet committed as new code — the
    drill script already existed, this pass just ran it): `pnpm run
    chaos:checkout-atomicity` against the real local Postgres, genuinely
    killing a backend connection mid-transaction during checkout. Result:
    **PASS** — `placeOrder()` correctly rejected, cart stayed ACTIVE, zero
    orders created, inventory reservation counts unchanged, zero orphaned
    reservations. One leftover test cart from an earlier misconfigured
    (missing env vars) attempt was found and cleaned from the dev
    database — not an app bug, an artifact of my own first invocation
    crashing before its own cleanup ran.
15. **Real k6 load tests executed** (k6 v2.2.0 downloaded fresh — not
    installed by default, per `infra/load-testing/README.md`) against a
    real `next build`/`next start` production server on port 3100, not
    `next dev`:
    - **`smoke.js`**: PASS. 40 requests across all 8 documented public
      routes, 0% failures, p95=96.43ms (threshold 2000ms).
    - **`browsing.js`**: PASS. Ramping scenario to 50 concurrent VUs
      (realistic browse funnel: home→shop→PDP with think-time and
      drop-off), 1321 real HTTP requests each hitting a real Prisma/
      Postgres query (no caching layer, by design — see the script's own
      comment), 0% failures, p95 112–128ms across all three route tiers
      against a 1200ms threshold (~9x headroom).
    - **`health-probes.js`**: first run genuinely FAILED —
      `http_req_failed rate=60%`, all 72 `/api/ready` requests returned
      503. Investigated instead of dismissed: `curl -v` showed
      `{"ready":false,"checks":{"config":"fail","database":"ok"}}`, and
      the server's own structured log showed exactly why:
      `SANTIMPAY_ENVIRONMENT: Invalid input` — I had started this
      particular server instance without setting that env var. This is
      the app's readiness check working *correctly* (refusing to report
      ready with invalid config, exactly the intended fail-safe
      behavior), not a bug. Restarted with the complete env var set,
      re-ran: PASS, 120/120 requests (12 simulated liveness + 12
      simulated readiness probes/replica, sustained 60s, matching the
      HPA's real max of 12 replicas), 0% failures, p99 279–314ms against
      an 800ms threshold. `/api/ready`'s real `SELECT 1` Postgres query
      held up fine under sustained concurrent load.
    - **`order-status-polling.js`**: PASS. Generated real fixture data first
      (`loadtest:seed-orders 200` — 200 disposable `SC-LOADTEST######`
      orders in a realistic status mix). Ramping to 100 concurrent
      "confirming payment" pollers, each hitting the same order repeatedly
      every 3s (matching the real client's actual poll interval) — 2162
      requests, 0% failures, p95=25.92ms/p99=44.87ms against 300ms/800ms
      thresholds. All 200 test orders and the fixture file deleted
      afterward — psql confirmed `DELETE 200`, nothing left behind.

## AUDIT FINDINGS — full detail

### Application-layer audit (dead code, payments, inventory, authz, secrets)
- **Dead code**: clean except one gap, fixed (see #6 above).
- **Payments**: webhook signature verification confirmed to actually
  *reject* tampered/wrong-key/stale callbacks (not just run) — see
  `packages/santimpay/test/webhook.test.ts`. Idempotency key generated
  once, persisted before the gateway call — `payment-service.ts:89`. Money
  is integer-only via a branded `Santim` type — `money.ts`.
- **Inventory concurrency**: real atomic conditional `UPDATE`, not
  check-then-write — `reservation.ts:87-92`. 8/8 integration tests pass
  (200-concurrent/1-unit and 50-concurrent/10-unit cases included).
- **Authorization**: admin gated server-side in a layout; customer order
  access scoped by session-derived `userId`, never client input. One
  deliberate, documented unauthenticated route (order status polling,
  returns no PII).
- **Secrets**: `.env.example` placeholders only, no hardcoded secrets in
  tracked source.

### Infra-layer audit (DB schema, migrations, security headers, rate
limiting, container, K8s manifests, Trivy ignore)
- **DB schema**: all 19 FKs had explicit onDelete (none relying on an
  implicit default); 4 Cascade-on-Order children identified as a latent
  risk and fixed (#11 above). Several real missing-index gaps found and
  fixed for orders/payment_intents/inventory_reservations (#11). One
  smaller, NOT yet fixed: `admin-queries.ts`'s orderNumber/email search
  uses a leading-wildcard `ILIKE '%term%'`, which no B-tree index can
  serve — would need `pg_trgm`/GIN. Admin-only feature, not payment/
  customer-critical — logged as P3, not fixed this pass.
- **Migrations**: all 4 (3 original + the new indexes/FK one) confirmed
  purely additive — no `DROP COLUMN`/`DROP TABLE`/destructive `ALTER`.
- **Security headers & rate limiting**: was a complete gap, now fixed
  (#10 above). The CSP added is intentionally conservative
  (`frame-ancestors`, `base-uri`, `form-action` only — no `script-src`
  lockdown) to avoid breaking the app without more extensive testing than
  this pass could safely verify; a fuller CSP is a real follow-up, not
  done here. Login/register still have no *application-level* brute-force
  lockout (only the edge-level rate limit now) — investigated
  `auth-actions.ts` directly, confirmed no attempt-counting exists; not
  implemented this pass (a stateful lockout needs careful design to avoid
  becoming its own DoS vector — a bigger, separate decision, not a quick
  fix). Logged as P2, not fixed.
- **Container security**: non-root confirmed pre-existing; base image
  pinned to a tag not a digest (P3, debatable tradeoff, not changed); dev
  deps shipping in the image and no HEALTHCHECK — both fixed (#12).
- **K8s manifests**: securityContext, resource requests, probes,
  networkpolicy (real default-deny, not a no-op), no hardcoded secrets —
  all confirmed clean, nothing to fix.
- **Trivy ignore file**: confirmed high-quality, dated, reasoned
  justifications for all 8 entries — nothing to fix.

## ACTIVE WORK

None in flight. All commits through `a31a199` are pushed and CI-confirmed
green (including the real Docker build + Trivy scan).

## P0 (critical — security / data-integrity / payment / system failure)

None found across either audit pass.

## P1 (production blocker / serious reliability issue)

None found in everything actually audited this pass. Phases not yet
freshly re-walked (full state-machine/idempotency sweep beyond payments/
inventory, broader chaos scenarios beyond the one drill run, load testing,
observability metric-name-vs-dashboard-query verification, K8s runtime
validation against a real cluster, backup/restore) may still surface P1s
— their absence here is not clearance.

## P2 (important, fix if practical)

- No application-level brute-force protection on login/register (edge
  rate-limiting now covers volumetric abuse, not targeted credential
  stuffing against one account). See AUDIT FINDINGS above.
- Known-unmergeable Dependabot PRs left open by design: #9 (Prisma 7),
  #10 (Next.js 16), #14 (TypeScript 7).
- CSP is conservative (no `script-src`/`style-src` lockdown) — a fuller
  policy is real follow-up work, not done this pass to avoid an unverified
  risk of breaking the app.

## P3 (improvement / backlog — must not block release)

- Admin orderNumber/email search has no trigram index for its `ILIKE
  '%term%'` pattern — slow at scale, admin-only, not customer/payment
  facing.
- Dockerfile base image pinned to a tag (`22.23.2-alpine`), not a digest.

## TESTS PASSED

- `@santim/santimpay` unit: 54/54.
- `@santim/web` unit: 30/30.
- `@santim/web` integration (real Postgres): 8/8.
- Typecheck: both packages, clean.
- Lint: both packages, clean, 0 errors/warnings.
- Real `next build` production build: succeeds.
- Real production server boot (`next start`) against a `pnpm prune --prod`
  pruned `node_modules`: real 200 response, all security headers present.
- Real CI Docker build + Trivy vulnerability scan (GitHub runners, real
  network access — this sandbox's Docker daemon has none): both pass.
- Real chaos drill (`chaos:checkout-atomicity`): PASS — see #14 above.
- Real k6 load tests (smoke, 50-VU browsing spike, 12-replica sustained
  health-probe load) against a real production server: all 3 PASS after
  fixing one test-setup misconfiguration (not an app bug) — see #15 above.
- kubeconform -strict schema validation, both overlays: 17/17 valid.
- Every commit's CI run individually confirmed green via `gh run watch`
  with a genuinely uncontested (non-cancelled) result — one earlier watch
  in this pass showed a false "failure" that was actually a concurrency-
  group cancellation from pushing too fast; caught via the GitHub API's
  real `conclusion` field, not assumed.

## TESTS FAILED

None currently open. (One real failure occurred and was fixed mid-pass:
the ShippingLabel cleanup-ordering bug caused by the new FK Restrict
constraint — see #11 above.)

## FIXES COMPLETED

See COMPLETED GATES above for the full list with commit SHAs.

## LAST COMMIT

`135e03e` — docs: verify Grafana dashboard metric names against real app
registrations. On `main`, pushed, CI confirmed green (all 4 jobs,
genuinely uncontested).

## NEXT ACTION

Phases not yet freshly re-walked with this session's evidence standard:

1. **Phase 5/6/7 detail** — state machine legality beyond what Phase 2
   spot-checked (payment/order transitions), idempotency for
   checkout/webhook/refund/cancellation/worker-jobs specifically (payment
   and inventory idempotency were confirmed; refund/cancellation were
   not).
2. **Phase 12/13** — broader test-pyramid review, more chaos scenarios
   (only DB-connection-kill during checkout was run; web/worker restart,
   duplicate webhook, delayed webhook are not yet freshly re-verified this
   pass, though the underlying webhook dedup mechanism was confirmed at
   the unit-test level in the audit).
3. **Phase 15** — load testing now has real evidence for 4 of 5 k6
   scenarios (smoke, browsing, health-probes, order-status-polling — see
   #15 above). Only `webhook-burst.js` was not run this pass — it needs
   `loadtest:seed-webhooks` fixtures and, per its own header comment,
   fixtures regenerated immediately before each run (they embed signed,
   time-sensitive payloads).
4. **Phase 17** — K8s runtime validation: only static (kubeconform) —
   no real cluster was available or provisioned (correctly out of scope
   per the mandate's own Phase 17 guidance).
5. **Phase 19/21** — backup/restore: still not established in this
   codebase (see `PRODUCTION-RELEASE.md` §11) — an infra/hosting decision,
   not resolvable from inside this repo alone.

If continuing: pick the highest-value item above, verify with real
evidence (run it, don't audit-and-assume), fix what's found, commit,
push, watch real CI to a genuinely uncontested completion before the next
push. If not continuing: the honest status is below.

## PRODUCTION READINESS STATUS

**CONDITIONALLY PRODUCTION-READY** for the scope actually audited and
fixed this pass — see the final structured report (delivered to the user
alongside this file) for the complete PASS/FAIL/UNVERIFIED breakdown and
every named limitation. Two full audit passes (application + infra layer)
found zero P0s and zero P1s; every real gap found was fixed, verified with
genuine evidence (real HTTP calls, real CI runs, a real chaos drill, real
schema validation), and pushed. What keeps this "conditional" rather than
unqualified: several phases were not freshly re-walked this pass (broader
chaos scenarios, load testing, observability query-correctness, backup/
restore), and those gaps are named explicitly above and in the final
report rather than assumed clear.
