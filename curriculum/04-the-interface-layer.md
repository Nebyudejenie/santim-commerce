# Phase 4 — The Interface Layer

*Same method as Phases 1–3: every claim is illustrated with a real file from `santim-commerce`.
Open the referenced file alongside this document. Where this codebase has prepared something but
not finished wiring it up, that's said plainly — it's more useful to know exactly where the edge
of "done" is than to read past it.*

---

## Why this phase exists

The master plan states this phase's whole thesis in one line: **"Cinematic" is a performance
budget, not a pile of animations.** Everything below either directly serves that budget (a
rendering strategy chosen per page, an image pipeline that ships the smallest bytes that look
right, motion with an off switch) or explains honestly where this codebase has laid groundwork —
a token system, prepared CSS — without yet spending the work to finish it. Both are worth knowing:
what's built, and precisely how far it goes.

---

## 1. Server Components and Server Actions

`cart-actions.ts` opens with the actual decision this codebase made, and — more valuably — the
reasoning for when it would make the *opposite* choice:

> Using Server Actions instead of a REST layer here is a deliberate choice, not a default: cart
> mutations are same-origin, form-shaped, and need no independent client (no mobile app calls
> this). A public API would be over-engineering for a need that doesn't exist yet. The webhook and
> order status endpoints ARE real HTTP routes (see `app/api/*`) because those DO have independent
> callers — SantimPay's servers and this app's own polling client.

**The generalizable rule, stated precisely:** the question is never "Server Actions or REST" as a
global architectural choice — it's "does this specific operation have a caller other than this
app's own same-origin forms?" Cart mutations don't. The SantimPay webhook and the order-status
poll (Phase 2 §§4–5) do — an external gateway and a client-side polling loop, respectively — which
is exactly why those two live as real `app/api/*` routes while every cart and checkout mutation is
a Server Action.

### 1.1 The shape of a real Server Action

```ts
"use server";
// ... imports elided (revalidatePath, prisma, cart-service, cart-cookie, logger)

export interface CartActionState {
  readonly ok: boolean;
  readonly error?: string;
}

export async function addToCartAction(
  _prev: CartActionState,
  formData: FormData,
): Promise<CartActionState> {
  const variantId = String(formData.get("variantId") ?? "");
  const quantity = Number(formData.get("quantity") ?? "1");

  if (!variantId) return { ok: false, error: "Choose a size before adding to your bag." };

  try {
    const token = await ensureCartToken();
    await addLine({ cartToken: token, variantId, quantity: Number.isFinite(quantity) ? quantity : 1 });
  } catch (error) {
    if (error instanceof VariantUnavailableError) {
      return { ok: false, error: "This item is no longer available." };
    }
    logger.error("cart.add_failed", { error: (error as Error).message, variantId });
    return { ok: false, error: "Couldn't add that to your bag. Please try again." };
  }

  revalidatePath("/cart");
  revalidatePath("/", "layout"); // refresh the cart count in the header
  return { ok: true };
}
```

`(prevState, formData) => Promise<State>` is not an arbitrary shape — it's exactly what React's
`useActionState` hook requires, and the client side of this pair shows why the shape matters:

```tsx
"use client";
// ... imports, VariantOption/props types elided

const [state, formAction, pending] = useActionState(addToCartAction, INITIAL_STATE);

return (
  <form action={formAction}>
    {/* ... hidden inputs, price, size-swatch group, stock note ... */}
    {state.error && <p className="alert alert--error">{state.error}</p>}
    {state.ok && <p className="alert alert--success">Added to your bag.</p>}
    <button
      type="submit"
      className="btn btn--primary btn--full btn--lg"
      disabled={!selected || selected.available === 0 || pending}
    >
      {pending ? "Adding…" : selected?.available === 0 ? "Out of stock" : "Add to bag"}
    </button>
  </form>
);
```

`useActionState` gives the component three things from one hook call: the last returned state (to
render success/error), the wrapped action to pass directly to `<form action={...}>`, and a
`pending` boolean React manages for you — no manual `isSubmitting` state, no manual try/catch
around a `fetch` call. **The part worth sitting with:** this same `<form action={formAction}>`
works with **zero client-side JavaScript** — it's a real HTML form posting to a real endpoint React
sets up server-side — and progressively *upgrades* to a no-full-reload transition the instant JS is
present. `cart-actions.ts`'s stepper actions make this explicit:

> `+/-` stepper actions that don't require client JS to compute the next quantity: they read the
> current line and adjust by one, server-side. A plain `<button formAction={...}>` works with zero
> JavaScript; React still upgrades it to a smooth, no-full-reload transition when JS is present.

### 1.2 Client components exist for exactly one reason here: instant feedback

`AddToCartForm` is a client component, and its own comment states precisely why, rather than
"because it needs interactivity" (true of almost everything, and therefore not a useful reason on
its own):

> Client component: variant selection needs instant feedback (stock note, price update, disabled
> sizes) that a full server round-trip would make feel sluggish. The actual mutation still goes
> through the Server Action — this component only owns which variant is currently selected.

**The actual division of labor:** `useState` owns *which size button is currently highlighted* —
purely local, purely visual, needs to feel instant. The moment the customer commits (clicks "Add to
bag"), control passes to the Server Action, which is the only thing that ever touches the database.
Reaching for a client component doesn't mean reaching for client-side data — it means reaching for
client-side *state that has no business round-tripping to a server before the pixel updates.*

---

## 2. Rendering strategy per page — and the subtlety of *why* each page needs what it needs

The master plan's concept list names three strategies: static catalog, dynamic cart, edge-cached
PDP. The real codebase's actual mechanism is more precise than "mark some pages static and some
dynamic" — and the precision is worth understanding exactly, because getting it wrong either way
has a real cost: force everything dynamic and you've thrown away the performance a static page
would have given you for free; assume something is static when it isn't and you serve a stale
snapshot of state that needed to be live.

### 2.1 Next.js infers dynamic rendering from what a page actually reads

Most of this codebase's pages carry **no** `export const dynamic = "force-dynamic"` at all —
`shop/page.tsx`, the homepage, the PDP, and (mostly) the cart page have no such export. That's not
an oversight; Next's App Router automatically opts a route into dynamic rendering the moment it
reads something that's inherently per-request — `cookies()`, `headers()`, `searchParams`, a
dynamic route segment. The cart page needs the customer's own cart, read via a cookie, so it's
dynamic *by virtue of what it does*, without ever needing the explicit override.

### 2.2 Where the explicit override earns its keep

Two real, adjacent comments in this codebase show exactly when `force-dynamic` is actually needed
— when a page's data comes from a database query with **no** automatic per-request signal at all:

```ts
// apps/web/src/app/admin/(dashboard)/page.tsx
// Without this, Next statically prerenders this page at BUILD time — no
// searchParams or dynamic segment here to force dynamic rendering the way
// /admin/orders (searchParams) and /admin/orders/[id] (route param) get it
// automatically. A frozen snapshot of "orders today" and "stuck payments" is
// actively dangerous on a dashboard whose entire job is showing what's true
// right now.
export const dynamic = "force-dynamic";
```

```tsx
// apps/web/src/app/admin/(dashboard)/reconciliation/page.tsx
// See admin/page.tsx's comment: no searchParams/route param here to force
// dynamic rendering automatically, and a stale reconciliation queue is worse
// than useless — it would show payments as "stuck" long after they resolved,
// or hide genuinely new stuck payments entirely.
export const dynamic = "force-dynamic";
```

Both comments make the same move: name the *specific* automatic trigger a sibling page has
(`/admin/orders`'s `searchParams`, `/admin/orders/[id]`'s route param) that *this* page lacks, and
state the concrete cost of getting it wrong (a frozen dashboard snapshot; a reconciliation queue
that lies about which payments are actually stuck). **The rule this teaches:** don't reach for
`force-dynamic` reflexively "to be safe" — figure out whether your page already has an automatic
trigger first, because a page that's dynamic without needing to be has given up caching for
nothing.

### 2.3 The full picture, read as a table

| Page | Dynamic how | Why |
|---|---|---|
| `/` (homepage), `/shop`, `/products/[slug]` | Static/ISR by default — no override | Catalogue data changes rarely; every visitor sees the same content |
| `/cart` | Auto-dynamic (reads the cart cookie) | Per-customer state, but Next detects this without an explicit export |
| `/account`, `/login`, `/register`, `/admin/login` | Explicit `force-dynamic` | Auth-dependent pages with no `searchParams`/route-param trigger of their own |
| `/checkout/[orderNumber]/{confirming,failed,cancelled}` | Explicit `force-dynamic` | Must reflect live order status (Phase 2 §4) — a cached "confirming" page would be exactly the redirect-is-not-proof bug from the other direction |
| `/admin` dashboard, `/admin/reconciliation` | Explicit `force-dynamic` | Live operational data with no automatic trigger (§2.2 above) |
| `/admin/orders`, `/admin/orders/[orderNumber]` | Auto-dynamic (`searchParams` / route param) | Filtering/pagination and the order id itself are already per-request signals |
| Every `app/api/*` route | Explicit `force-dynamic` | Never cache a webhook receiver or a status poll — see Phase 2 §5's FAST/HONEST/PARANOID/RAW contract |

---

## 3. Design tokens, and dark mode as infrastructure, not an afterthought

`globals.css` opens with two rules its own header comment states as non-negotiable:

> 1. NOTHING BUT TOKENS ON `:root`. Light is the default (bare `:root`); dark overrides live in the
>    two guarded blocks below, so an explicit `data-theme` wins over the OS preference and the OS
>    preference wins over nothing at all.
> 2. MOTION HAS AN OFF SWITCH. Every transition/animation duration route through `--duration-*`
>    variables, which `prefers-reduced-motion` zeroes out in one place — not scattered across every
>    component that animates.

### 3.1 Three-way theme precedence, and why the layering order matters

```css
:root {
  --bg: #faf9f7;   /* light, the default */
  /* ... every other token ... */
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14130f;   /* OS says dark, UNLESS the user explicitly chose light */
  }
}

:root[data-theme="dark"] {
  --bg: #14130f;   /* user explicitly chose dark — wins regardless of OS */
}
```

Three layers, and the order they're declared in the file is the order of precedence, low to high:
bare `:root` (the unconditional default) → OS preference *guarded* against an explicit override →
an explicit `data-theme` attribute, which wins outright in either direction. The `:not([data-theme
="light"])` guard on the OS-preference block is the detail that makes this actually work: without
it, a user who explicitly picked light mode on a dark-OS device would see their choice overridden
by the media query, because CSS specificity alone doesn't know about *intent* — only this guard
encodes "the OS preference applies only when nobody has said otherwise."

### 3.2 Motion's off switch lives at the token layer, not in each component

```css
:root {
  --duration-fast: 150ms;
  --duration-base: 300ms;
  --duration-slow: 550ms;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast: 0ms;
    --duration-base: 0ms;
    --duration-slow: 0ms;
  }
}
```

Every animated rule in this codebase references `var(--duration-*)` rather than a literal
millisecond value — which means `prefers-reduced-motion: reduce` disables **every** animation in
the app by overriding three variables in one place, rather than requiring every component author to
remember to wrap their own `transition:` declaration in its own media query. **This is the same
principle as Phase 1's single-decision-path idea, applied to accessibility instead of payment
state:** one place decides "is motion allowed right now," and everything downstream just asks.

---

## 4. Motion that means something — and one real, honest gap

### 4.1 Orchestrated entrance, driven by a CSS custom property

`ProductCard` passes its own grid position as a CSS variable, and the animation reads it back to
compute a staggered delay:

```tsx
<Link
  href={`/products/${product.slug}`}
  className="product-card rise-in"
  style={{ "--stagger": index } as React.CSSProperties}
>
```

```css
@keyframes rise-in {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}

.rise-in {
  animation: rise-in var(--duration-slow) var(--ease-out) both;
  animation-delay: calc(var(--stagger, 0) * 60ms);
}

@media (prefers-reduced-motion: reduce) {
  .rise-in { animation: none; }
}
```

**Why this is "motion that means something" rather than decoration:** the stagger isn't random or
purely aesthetic — it's the grid's own left-to-right, top-to-bottom order, translated into time,
which reinforces the layout the customer already sees rather than fighting it. And it has its own,
*local* `prefers-reduced-motion` override in addition to the global duration-zeroing from §3.2 —
belt and suspenders, because `animation-delay` with a `0ms` duration would still technically apply
a delay before showing nothing, and this rule removes the animation itself rather than relying
solely on the duration having been zeroed elsewhere.

### 4.2 Prepared, not finished: the View Transitions CSS that nothing triggers yet

`globals.css` also defines this, immediately after the `rise-in` rules:

```css
/* Shared-element style crossfade for route-level view transitions. */
::view-transition-old(root),
::view-transition-new(root) {
  animation-duration: var(--duration-base);
}
```

This is real CSS, using the real View Transitions API's pseudo-elements — and it is **currently
inert**. A repo-wide search turns up no call to `document.startViewTransition()` anywhere in this
codebase's client code, and `next.config.ts` does not enable Next's experimental `viewTransition`
App Router flag. The styling is ready to receive a transition the moment one is triggered; nothing
in this codebase triggers one yet.

**This is worth being exactly this precise about, not glossed over,** for the same reason Phase 2
was precise about the unbuilt ledger and Phase 3 was precise about the audit trail not being event
sourcing: a comment claiming "shared-element style crossfade for route-level view transitions"
sitting next to genuinely inert CSS is *exactly* the kind of thing that looks finished on a skim
and isn't — and the gap between "the styling exists" and "the feature works" is precisely where
Lab 4.1 below asks you to do the remaining work yourself.

---

## 5. Accessibility, in the actual markup

### 5.1 Skip link — the first thing a keyboard user can do on any page

```css
.skip-link {
  position: absolute;
  top: -100%;
  left: var(--space-4);
  z-index: 100;
  padding: var(--space-3) var(--space-4);
  background: var(--accent);
  color: var(--accent-fg);
  border-radius: var(--radius-sm);
  transition: top var(--duration-fast) var(--ease-out);
}

.skip-link:focus { top: var(--space-4); }
```

```tsx
<a href="#main" className="skip-link">Skip to content</a>
```

Positioned off-screen (`top: -100%`) until it receives keyboard focus, at which point it slides
into view. A sighted mouse user never sees it; a keyboard or screen-reader user tabbing from the
top of the page gets an immediate way to jump past the header navigation straight to `#main` —
without this, every single page load costs a keyboard user several tab-presses through the same
header links before reaching content that changes.

### 5.2 Icon-only controls: `aria-label` on the link, `aria-hidden` on the icon

`site-header.tsx`'s cart link is a small, precise example of a pattern that's easy to get
subtly wrong:

```tsx
<Link href="/cart" className="site-header__cart" aria-label={`Bag, ${count} item${count === 1 ? "" : "s"}`}>
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    {/* ... */}
  </svg>
</Link>
```

Two things have to be true together for this to work correctly. First, `aria-hidden="true"` on the
SVG — without it, some screen readers announce raw path/shape data, or nothing meaningful, in
addition to whatever label the link carries. Second, the `aria-label` on the **link itself**,
computed dynamically from the real item count — not a static "Cart" label that never changes. A
screen reader user gets "Bag, 3 items," matching exactly what a sighted user sees rendered as a
number badge, kept in sync because both read from the same `count` value rather than one being an
after-the-fact static label someone forgot to update.

### 5.3 A live region that doesn't require a page reload to announce

`AddToCartForm`'s stock note uses `role="status"`, which browsers map to an implicit
`aria-live="polite"` region:

```tsx
<p className={"stock-note " + /* ... */} role="status">
  {selected
    ? selected.available === 0
      ? "Out of stock in this size"
      : selected.available <= 5
        ? `Only ${selected.available} left`
        : "In stock"
    : ""}
</p>
```

When the customer picks a different size and the client-side state updates, a screen reader
announces the new stock message **without** the customer needing to re-find and re-read that part
of the page — the same information a sighted user gets instantly from the text changing color and
content. The size swatches themselves use `aria-pressed` (`role="group"` with `aria-labelledby`
naming the group) rather than relying on `data-selected`'s purely visual styling to convey which
option is chosen:

```tsx
<button
  key={v.id}
  type="button"
  className="option-swatch"
  data-selected={v.id === selectedId}
  disabled={v.available === 0}
  onClick={() => setSelectedId(v.id)}
  aria-pressed={v.id === selectedId}
>
  {v.options[optionKey]}
</button>
```

`data-selected` drives the CSS; `aria-pressed` drives what assistive technology announces. Neither
alone is sufficient — a purely visual `data-selected` tells a screen reader nothing, and
`aria-pressed` alone with no visual treatment tells a sighted user nothing.

---

## 6. Image pipeline

`next.config.ts` configures the format negotiation once, for every image the app serves:

```ts
images: {
  remotePatterns: [{ protocol: "https", hostname: "picsum.photos" }],
  formats: ["image/avif", "image/webp"],
},
```

Next's Image Optimization API negotiates the best format the requesting browser actually supports
from this list, falling back further down automatically — AVIF where supported (smallest files,
newest format), WebP as the wide-support middle ground, and an implicit further fallback for
anything older. No component decides this per-image; it's decided once, centrally, the same "one
decision, many callers" shape as `calculateTax()` in Phase 3 §5.1.

### 6.1 `sizes` — telling the browser which of many generated images to actually fetch

```tsx
// product-card.tsx
<Image
  src={image.url}
  alt={image.alt}
  width={image.width ?? 800}
  height={image.height ?? 1000}
  sizes="(min-width: 1024px) 25vw, (min-width: 640px) 45vw, 90vw"
  className="product-card__image"
/>
```

`next/image` generates a `srcset` with several candidate widths automatically; `sizes` is what
tells the browser **which one it actually needs**, before layout has necessarily finished — on a
wide desktop viewport this card occupies roughly a quarter of the row (`25vw`), on a tablet closer
to half (`45vw`), and on mobile nearly the full width (`90vw`). Get this wrong (or omit it, which
defaults to assuming the image is as wide as the viewport) and the browser downloads a
far-larger-than-displayed image on every grid page — bytes paid for and never used, directly
costing the LCP (Largest Contentful Paint) budget this whole phase is organized around.

### 6.2 `priority` — spending the preload budget on the one image that's LCP

```tsx
// (storefront)/page.tsx — homepage hero
<Image src={...} priority ... />
// products/[slug]/page.tsx — PDP primary image
<Image src={...} priority ... />
```

`priority` tells Next to preload this specific image and skip its default lazy-loading — correct
for exactly the images likely to *be* the page's Largest Contentful Paint element (a hero, a
product's primary photo) and actively harmful if applied broadly, because preloading competes for
the same limited early-connection bandwidth every other resource on the page needs. Every other
`<Image>` in this codebase — the grid of `ProductCard`s below the fold, thumbnails — has no
`priority` prop, and lazy-loads by `next/image`'s own default. **The rule: `priority` is a scarce
resource, not a settings you turn on when an image "seems important."** It should appear on
roughly one image per page — the one your Lighthouse trace would otherwise name as LCP.

---

## 7. Core Web Vitals and the Lighthouse gate — introduced here, not yet measured

The master plan's gate for this phase is specific: **Lighthouse ≥ 95 performance/accessibility on
the PDP, with the animations on.** This codebase has no Lighthouse configuration file, and `ci.yml`
(Phase 2's own subject) runs no Lighthouse step — this gate is not currently automated anywhere in
this project. That's an honest gap, not a claim to walk past: everything in §§2–6 above is real,
shipped code that *should* score well against exactly this gate, but nobody has actually run the
measurement and wired it into CI to prove it, or to catch a regression the next time someone adds
an unoptimized image or an unbounded animation.

**The three metrics worth knowing precisely, because "Lighthouse ≥ 95" is otherwise just a number:**

| Metric | What it measures | What in this codebase serves it |
|---|---|---|
| **LCP** (Largest Contentful Paint) | Time until the biggest visible element renders | `priority` on hero/PDP images (§6.2), AVIF/WebP negotiation (§6), static rendering of catalogue pages (§2.3) meaning no server round-trip blocks the render |
| **INP** (Interaction to Next Paint) | Responsiveness of the page to a real interaction — click, tap, keypress | Client-owned local state for instant swatch selection (§1.2), `useActionState`'s `pending` flag disabling double-submits rather than blocking the whole UI |
| **CLS** (Cumulative Layout Shift) | How much content visibly jumps around as it loads | Explicit `width`/`height` on every `<Image>` (reserved layout space before the image bytes arrive — the schema's own `ProductImage.width`/`height` fields exist for exactly this) |

Turning this from "should score well" into "does score well, continuously" is exactly what Lab 4.4
below asks you to build.

---

## Labs

### Lab 4.1 — Finish the View Transitions wiring

§4.2's CSS is ready; nothing calls it. Enable Next's `experimental.viewTransition` App Router flag
(check the Next.js version this project pins for the exact current API — this has moved between
Next releases) and wrap the storefront's navigation in `document.startViewTransition()` where
appropriate — PDP-to-PDP navigation between two products is the natural first case, since it's the
"shared-element" scenario the existing comment already names. Confirm the crossfade actually
happens, confirm `prefers-reduced-motion: reduce` still suppresses it (the `--duration-base`
token from §3.2 should still apply inside `::view-transition-old/new(root)`), and confirm nothing
else in the app broke — View Transitions can interact unexpectedly with client-side state that
expects to persist across a "navigation" that visually looks like a single continuous page.

### Lab 4.2 — Break the rendering-strategy assumption on purpose

Remove `export const dynamic = "force-dynamic"` from the admin dashboard page. Build and start the
app in production mode (`next build && next start`, not `next dev` — dev mode's behavior here
differs from production). Seed a new order, confirm it's paid, then load the dashboard. Confirm you
see a stale, build-time snapshot of "orders today" — exactly the bug the page's own comment (§2.2)
warns about. Put the export back; confirm the dashboard now reflects the new order immediately.

### Lab 4.3 — Prove the `sizes` attribute actually matters

Using your browser's network tab, load the `/shop` grid on a genuinely narrow viewport (or actual
mobile device) and note the transferred size of one product image. Then temporarily change that
card's `sizes` value to `100vw` — as if the browser should assume the image is always full-viewport
width, the common mistake this attribute exists to prevent — reload, and compare the transferred
bytes for the identical visual result. The difference is real bytes a real customer on a real
mobile connection would have paid for, gone.

### Lab 4.4 — Wire the Lighthouse gate into CI, for real

This codebase's actual missing piece (§7). Add a Lighthouse CI step — `@lhci/cli` against a built,
running instance of the PDP, animations on, is the master plan's literal gate — to `ci.yml`,
following the same verification discipline the rest of that file's own history in this curriculum
demonstrates: don't just add the step and assume it works, actually watch it run in real CI,
confirm it fails when you deliberately regress something (strip a `sizes` attribute, remove a
`priority` flag from the PDP hero, or add an unbounded animation with no reduced-motion guard), and
confirm it passes clean once you revert. This is the one lab in this curriculum, so far, whose
"solution" is a permanent addition to the real pipeline, not a throwaway exercise — treat it that
way.

---

## Gate — do not proceed to Phase 5 until you can do this cold

1. **A page has no `export const dynamic`. What determines whether it's static or dynamic, and
   name one real trigger from this codebase for each outcome.** (Whether it reads an inherently
   per-request API — `cookies()`, `searchParams`, a dynamic route segment — automatically opts it
   into dynamic rendering; absent any of those, it's static/ISR by default.)
2. **Why does `prefers-reduced-motion` get handled once, in the token layer, instead of once per
   animated component?** (One decision point instead of N places someone has to remember —
   directly analogous to Phase 1's single-decision-path principle for payment state, applied to
   accessibility.)
3. **Find one piece of CSS or comment in this codebase that describes a feature which isn't
   actually active yet, and explain precisely what's missing to activate it.** (The View
   Transitions crossfade rules — missing: any call to `startViewTransition()` and the Next.js
   experimental flag to enable it.)
4. **Why does `priority` appear on roughly one `<Image>` per page instead of being a default
   good practice to apply broadly?** (It competes for the same limited early-connection bandwidth
   every other resource needs; applied broadly, nothing is actually prioritized. It belongs on the
   one image likely to be the page's LCP element, and nowhere else.)
5. **This phase's own Lighthouse gate isn't automated anywhere in this codebase. What's the actual
   risk of that gap, concretely — not "it would be nice to have it automated"?** (Every piece of
   work in §§2–6 that serves the gate can silently regress — an image losing its `sizes` attribute,
   an animation shipped without a reduced-motion guard — with nothing in CI to catch it before a
   real customer's Lighthouse score drops.)

---

*Next: `05-containers-and-the-local-platform.md` — Phase 5: everything `docker-compose.yml` and
the multi-stage `Dockerfile` are actually doing, and why layer order is, in the Dockerfile's own
words, "the whole game."*
