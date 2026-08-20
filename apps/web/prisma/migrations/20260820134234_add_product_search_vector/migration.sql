-- Real marketplace search: Postgres full-text search (weighted, ranked) plus
-- pg_trgm for typo-tolerant fuzzy fallback. Hand-written because Prisma's
-- schema DSL has no representation for a GENERATED ALWAYS AS ... STORED
-- column — see Product.searchVector's own comment in schema.prisma.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Weighted: title matches rank highest (A), brand/subtitle next (B),
-- description lowest (C) — ts_rank uses these weights automatically.
-- STORED (not virtual) so it can be indexed directly, and so a search never
-- pays the tsvector-computation cost at query time — only once, on write.
ALTER TABLE "products" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("brand", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("subtitle", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'C')
  ) STORED;

CREATE INDEX "products_search_vector_idx" ON "products" USING GIN ("searchVector");

-- Typo tolerance: trigram similarity on title, used as a fallback when a
-- full-text query returns nothing (e.g. "runing shoe" for "running shoe").
CREATE INDEX "products_title_trgm_idx" ON "products" USING GIN ("title" gin_trgm_ops);
