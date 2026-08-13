# Runbook: Backup / restore drill

**Severity:** N/A — this is a scheduled exercise, not an incident response. Run it on a real
cadence (monthly, minimum) whether or not anything is wrong. **An untested backup is not a
backup** — the only way to know a restore procedure actually works is to have run it, recently,
against the current schema.

This exact procedure was run once already, on 2026-08-13, as part of building this platform —
every command below is copy-pasted from a real execution, not a hypothetical. Results:

- `pg_dump` of the full schema + data succeeded, 48KB for the seeded demo catalogue.
- Restore into a completely fresh, empty Postgres container succeeded with zero errors —
  every table, index, and foreign key constraint recreated.
- Row counts for every table matched the source exactly (products, variants, collections,
  collection_products, product_images, inventory, users, sessions).
- An exact-value spot check (a specific product's slug/title/heroImage) matched byte-for-byte.
- **Constraint enforcement was verified, not assumed**: a duplicate SKU insert against the
  restored database was correctly rejected (`duplicate key value violates unique constraint
  "variants_sku_key"`), and an orphan variant referencing a non-existent product was correctly
  rejected (`violates foreign key constraint "variants_productId_fkey"`). A restore that recreates
  the DATA but silently drops a constraint is a real failure mode this step exists to catch.

## 1. Take the backup

```bash
# From inside the Postgres container (adjust container name per environment):
docker exec <postgres-container> pg_dump -U santim -d santim_commerce \
  --format=custom --file=/tmp/santim_backup.dump

# Copy it out to wherever backups are actually retained (S3, GCS, etc. in
# real environments — this drill used local disk deliberately, to test the
# restore mechanics in isolation from any cloud storage integration).
docker cp <postgres-container>:/tmp/santim_backup.dump ./santim_backup.dump
```

`--format=custom` (not plain SQL) is deliberate: it's compressed, supports parallel restore via
`pg_restore -j`, and — critically for this drill — lets you restore into a database that already
has a different schema version without a plain-text `CREATE TABLE` colliding, since `pg_restore`
can be told to skip pre-existing objects if needed.

## 2. Capture a baseline BEFORE restoring anywhere

Row counts per table, plus at least one exact-value spot check. Comparing "did it work" against
nothing is not verification:

```bash
docker exec <postgres-container> psql -U santim -d santim_commerce -t -c "
  select 'products', count(*) from products
  union all select 'variants', count(*) from variants
  union all select 'orders', count(*) from orders;
  -- add every table that matters for your current drill
"
```

## 3. Restore into an ISOLATED environment — never directly over a live database

```bash
docker run -d --name restore-drill \
  -e POSTGRES_USER=santim -e POSTGRES_PASSWORD=santim -e POSTGRES_DB=santim_commerce \
  -p 15432:5432 postgres:17-alpine

# wait for it to accept connections
until docker exec restore-drill pg_isready -U santim -d santim_commerce; do sleep 1; done

docker cp ./santim_backup.dump restore-drill:/tmp/santim_backup.dump
docker exec restore-drill pg_restore -U santim -d santim_commerce \
  --no-owner --no-privileges -v /tmp/santim_backup.dump
```

`--no-owner --no-privileges`: the dump's original role (`santim`) may not exist by that exact
name in whatever environment you're restoring into during a real disaster — stripping ownership
info lets `pg_restore` create objects owned by whatever role you're currently connected as,
rather than failing on a missing role.

## 4. Verify — data AND constraints, not just "the command exited 0"

```bash
# Row counts must match the Step 2 baseline exactly.
docker exec restore-drill psql -U santim -d santim_commerce -t -c "select count(*) from products;"

# At least one exact spot check.
docker exec restore-drill psql -U santim -d santim_commerce -c \
  "select slug, title from products where slug = 'aria-overshirt';"

# Constraints must actually be enforced, not merely present in \d output —
# deliberately try to violate one and confirm it's rejected:
docker exec restore-drill psql -U santim -d santim_commerce -c "
  insert into variants (id, \"productId\", sku, title, options, \"priceSantim\", position, active, \"createdAt\", \"updatedAt\")
  select 'test-dup', \"productId\", sku, title, options, \"priceSantim\", position, active, now(), now()
  from variants limit 1;
" # MUST fail with "duplicate key value violates unique constraint"
```

## 5. Tear down the drill environment

```bash
docker stop restore-drill && docker rm restore-drill
rm -f santim_backup.dump   # or move to encrypted long-term storage if this run is being retained
```

## What this drill does NOT cover — and why that's a real gap, not an oversight

- **RTO/RPO measurement.** This drill proves *correctness* of a restore, not how long one takes
  under a realistic production data volume. Time it explicitly once the database is
  production-sized; `pg_restore -j N` (parallel restore) becomes relevant at that point.
- **Point-in-time recovery (PITR).** `pg_dump` is a snapshot at the moment it ran — it cannot
  recover to "just before the bad migration at 14:32," only to whenever the last dump happened.
  Real PITR needs WAL archiving (`archive_mode`, a WAL-shipping tool, or a managed provider's
  built-in PITR) — set that up before this matters, not after the incident that needs it.
- **Cross-region / provider-outage recovery.** This drill restored on the same host. A real DR
  posture needs the backup itself stored somewhere that survives the primary region being down.
- **The application's own recovery, not just the database's.** A restored database with a stale
  snapshot means the worker's reconciler (see `01-stuck-payment.md`) has real work to do the
  moment the app reconnects — payments that resolved at SantimPay after the snapshot was taken
  aren't reflected yet. Confirm the reconciler sweep actually catches up after a real restore, not
  just that the data loaded.

## Prevention / process

- [ ] Is this drill actually scheduled (calendar reminder, not "we'll remember")? A backup
      strategy that depends on someone remembering to test it is not a strategy.
- [ ] Does the RESULT of each drill run get recorded somewhere (even just a dated line in this
      file)? "We did it once in 2026" stops being reassuring after the schema has changed six
      times since.
- [ ] Is the backup encrypted at rest wherever it's actually retained long-term? This drill's
      local-disk dump was fine for testing the mechanics; a real backup sitting in S3
      unencrypted is a data-breach risk in its own right, separate from whether restore works.
