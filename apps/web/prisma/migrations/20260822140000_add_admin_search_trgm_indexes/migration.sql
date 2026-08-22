-- P3 backlog item, logged in docs/PROJECT-EXECUTION-STATE.md's own infra
-- audit: admin-queries.ts's orderNumber/email/name search uses a
-- leading-wildcard `ILIKE '%term%'` (Prisma's `contains`), which no plain
-- B-tree index can serve — Postgres has to scan every row. Same fix
-- already applied to products.title (see the earlier
-- 20260820134234_add_product_search_vector migration's own comment) —
-- pg_trgm was already enabled there, so this migration only adds the
-- indexes themselves, admin-only and non-payment-critical but genuinely
-- slow once the orders/users tables have real production volume.
--
-- Like products_title_trgm_idx, deliberately NOT modeled in schema.prisma
-- — Prisma's schema DSL has no representation for a GIN/gin_trgm_ops
-- index, and (confirmed by every `prisma migrate diff` run this session)
-- Prisma's migration tooling leaves an index it doesn't recognize alone
-- rather than trying to drop it.

CREATE INDEX "orders_order_number_trgm_idx" ON "orders" USING GIN ("orderNumber" gin_trgm_ops);
CREATE INDEX "orders_email_trgm_idx" ON "orders" USING GIN ("email" gin_trgm_ops);
CREATE INDEX "users_email_trgm_idx" ON "users" USING GIN ("email" gin_trgm_ops);
CREATE INDEX "users_name_trgm_idx" ON "users" USING GIN ("name" gin_trgm_ops);
