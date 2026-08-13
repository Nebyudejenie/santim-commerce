# Runbook: Chaos engineering drills

**Severity:** N/A — scheduled exercises, like the backup/restore drill. The entire point of chaos
engineering is injecting failure ON PURPOSE, on your own schedule, so the first time a given
failure mode happens for real isn't also the first time anyone finds out how the system behaves
under it.

Both drills below were run for real on 2026-08-13 while building this platform. Every number is
an actual result, not a projection.

## Drill 1: checkout transaction atomicity under a mid-flight database kill

**Question:** if Postgres crashes, or the network partitions, in the middle of `placeOrder()`'s
transaction — order creation + inventory reservation + cart conversion, all wrapped in one
`prisma.$transaction()` — does anything partial survive?

**Run it:**

```bash
pnpm run chaos:checkout-atomicity
```

**How it works:** a naive test would race a monitoring loop against the transaction's own
completion — and lose, because a small transaction finishes in single-digit milliseconds on
localhost, faster than `pg_stat_activity` can be polled and reacted to. This drill instead
deliberately STALLS the transaction — a second connection takes a `SELECT ... FOR UPDATE` lock on
the exact row `reserveForOrder()` will try to update first, so `placeOrder()` genuinely blocks,
observably, for as long as needed. Only once it's confirmed blocked does the drill find its
backend PID and kill it — with `pg_terminate_backend()`, which is functionally identical to a
real crash or network partition from the application's point of view.

**Result (2026-08-13):**

```
Test cart created: chaos-drill-1786607739336
Lock acquired — placeOrder()'s UPDATE will now block on it.
Killed the transaction's backend while it was blocked mid-UPDATE.
placeOrder() correctly rejected
Cart still ACTIVE: true
Zero orders created: true
Inventory reservation counts unchanged: true
Zero orphaned reservations: true

PASS: checkout transaction is atomic under a mid-flight connection kill.
```

**A real false-negative worth knowing about:** the first version of this drill reported a
spurious FAIL — 8 "orphaned" reservation rows with no order. They turned out to predate the drill
entirely: leftovers from manually running `DELETE FROM orders` directly in `psql` during earlier
testing, which (correctly, per the schema's `onDelete: SetNull` on
`InventoryReservation.orderId`) orphaned their reservation rows instead of releasing them, because
raw SQL deletes bypass the application's own release-on-cancel logic. **The lesson generalizes
directly to a real incident:** manual database surgery during an outage can leave exactly this
kind of debris behind. Prefer the application's own code paths (or a documented, reviewed script)
over ad-hoc `DELETE` statements, even when firefighting.

## Drill 2: worker `SIGKILL` mid-tick — resume correctness

**Question:** if the worker process is killed with zero warning (`SIGKILL`, not `SIGTERM` — no
chance to run the graceful-shutdown handler in `worker/index.ts`) while it's partway through
processing a batch of due payments, does a freshly restarted worker resume cleanly? Does anything
get double-processed, skipped, or left in a corrupt state?

**Procedure** (not yet a single script — see below for why):

```bash
# 1. Seed N payment intents that are immediately due for polling:
#    (create real orders + PaymentIntent rows with nextPollAt in the past)

# 2. Start the worker, then kill it almost immediately — before its first
#    tick can finish a large batch:
pnpm run worker &
sleep 0.15 && kill -9 $(lsof -i :9091 -sTCP:LISTEN -t)

# 3. Inspect payment_intents.pollAttempts — confirm a clean split: some
#    rows fully processed (pollAttempts incremented, nextPollAt pushed out),
#    the rest completely untouched (pollAttempts still 0). No row should
#    ever show a null/negative/impossible value.

# 4. Restart the worker and let it run for a few ticks. Confirm the
#    untouched rows get processed, and the already-processed rows are NOT
#    reprocessed until their own backoff window has genuinely elapsed.
```

**Result (2026-08-13), 40 seeded intents:**

- `SIGKILL` sent 150ms after boot, landed genuinely mid-tick — the worker's log showed processing
  stopped after exactly 18 of 40 intents.
- Database state after the kill: **18 intents at `pollAttempts=1`, 22 at `pollAttempts=0`, zero
  rows with a corrupted or partial value.** Each intent transitions atomically from "untouched" to
  "fully processed" — there is no observable in-between state on any single row, even when the
  *process itself* is killed between loop iterations.
- Fresh worker restarted. After it ran for ~15s: **22 intents at `pollAttempts=1` (their first,
  now-completed attempt), 18 at `pollAttempts=2`.** The 18 were NOT reprocessed immediately —
  their prior 10-second backoff window had already elapsed by the time the restarted worker's
  next tick ran, so a second attempt was legitimately due, not a duplicate. Zero corrupted rows
  throughout.

**Why this isn't a single repeatable script (yet):** unlike Drill 1, this one requires
orchestrating process start → precisely-timed kill → state inspection → restart → a second
inspection window — genuinely multi-stage shell orchestration, not one atomic assertion. It's a
reasonable candidate to promote into a script the same way Drill 1 was, if this becomes a
regular exercise; documenting the exact steps here is the honest interim version.

## Prevention / process

- [ ] Are these drills actually scheduled, or did they happen once because a codebase was being
      built and are now just... here? (Being honest: right now it's the latter. Put them on the
      same calendar as the backup/restore drill.)
- [ ] Does CI run Drill 1 automatically before a release that touches `checkout-service.ts`'s
      transaction body? It's fast (a few seconds) and fully self-cleaning — there's no real reason
      it couldn't be a required check on that specific file's changes.
- [ ] Promote Drill 2 into a script once it's run more than twice by hand — the moment "the
      procedure" starts drifting between runs is the moment it stops being trustworthy.
