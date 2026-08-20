/**
 * Real marketplace search — Postgres full-text search (weighted, ranked via
 * `ts_rank` against the `searchVector` generated column — see
 * schema.prisma's Product.searchVector) with a trigram-similarity fallback
 * for typo tolerance, faceted filtering, and pagination. Explicitly NOT a
 * `title ILIKE '%...%'` scan: that can't rank, can't tolerate a misspelling,
 * and can't use an index for a leading wildcard.
 *
 * Two-step hydration, deliberately: the raw SQL query below computes
 * ranking/filtering/pagination and returns an ORDERED list of product ids
 * plus a total count; the actual product objects are then fetched through
 * the normal Prisma query builder using catalogue-service.ts's own
 * ACTIVE_VARIANT_WITH_STOCK/VISIBLE_PRODUCT_WHERE, so search results have
 * the exact same shape (and the exact same visibility rules) as every other
 * catalogue listing — no second, drifting definition of "what a product
 * card needs" or "what's visible to buyers".
 *
 * Every user-supplied value below is passed as a `Prisma.sql` tagged-
 * template interpolation, never string-concatenated — Prisma parameterizes
 * these exactly like a prepared statement, so this is not a SQL-injection
 * surface despite being raw SQL.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { ACTIVE_VARIANT_WITH_STOCK, VISIBLE_PRODUCT_WHERE } from "../catalogue/catalogue-service.js";
import { expandSynonyms } from "./synonym-expansion.js";

export type SearchSort = "relevance" | "price_asc" | "price_desc" | "newest";

export interface SearchParams {
  readonly query?: string;
  readonly brand?: string;
  readonly collectionSlug?: string;
  readonly sellerSlug?: string;
  readonly minPriceSantim?: number;
  readonly maxPriceSantim?: number;
  readonly sort?: SearchSort;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface BrandFacet {
  readonly brand: string;
  readonly count: number;
}

export interface SearchResult {
  readonly products: Awaited<ReturnType<typeof hydrateProducts>>;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly brandFacets: BrandFacet[];
}

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 60;
// Below this trigram similarity, a "fuzzy" match is noise, not a typo —
// 0.2 is Postgres's own commonly-cited starting point for pg_trgm, kept
// here as a named constant so the threshold has one place to tune.
const TRIGRAM_SIMILARITY_THRESHOLD = 0.2;

/** Shared WHERE fragments so the facet query and the results query can
 * never drift from each other — every fragment except the one matching
 * `excludeBrand` is reused verbatim for brand facet counting. */
function buildFilterFragments(params: SearchParams, options: { excludeBrandFilter?: boolean } = {}) {
  const fragments: Prisma.Sql[] = [
    Prisma.sql`p."status" = 'ACTIVE'`,
    Prisma.sql`s."status" = 'APPROVED'`,
  ];

  const trimmedQuery = (params.query ?? "").trim();
  if (trimmedQuery) {
    const expanded = expandSynonyms(trimmedQuery);
    fragments.push(
      Prisma.sql`(
        p."searchVector" @@ websearch_to_tsquery('english', ${expanded})
        OR similarity(p."title", ${trimmedQuery}) > ${TRIGRAM_SIMILARITY_THRESHOLD}
      )`,
    );
  }

  if (params.brand && !options.excludeBrandFilter) {
    fragments.push(Prisma.sql`p."brand" = ${params.brand}`);
  }

  if (params.collectionSlug) {
    fragments.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "collection_products" cp
        JOIN "collections" c ON c."id" = cp."collectionId"
        WHERE cp."productId" = p."id" AND c."slug" = ${params.collectionSlug}
      )`,
    );
  }

  if (params.sellerSlug) {
    fragments.push(Prisma.sql`s."slug" = ${params.sellerSlug}`);
  }

  if (params.minPriceSantim != null) {
    fragments.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "variants" v
        WHERE v."productId" = p."id" AND v."active" AND v."priceSantim" >= ${params.minPriceSantim}
      )`,
    );
  }

  if (params.maxPriceSantim != null) {
    fragments.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "variants" v
        WHERE v."productId" = p."id" AND v."active" AND v."priceSantim" <= ${params.maxPriceSantim}
      )`,
    );
  }

  return fragments;
}

function orderByClause(sort: SearchSort, hasQuery: boolean): Prisma.Sql {
  switch (sort) {
    case "price_asc":
      return Prisma.sql`min_price ASC NULLS LAST, p."id" ASC`;
    case "price_desc":
      return Prisma.sql`min_price DESC NULLS LAST, p."id" ASC`;
    case "newest":
      return Prisma.sql`p."createdAt" DESC, p."id" ASC`;
    case "relevance":
    default:
      // Relevance only means something when there's a query; browsing
      // without one falls back to newest-first, same as listAllProducts.
      return hasQuery ? Prisma.sql`score DESC, p."createdAt" DESC` : Prisma.sql`p."createdAt" DESC, p."id" ASC`;
  }
}

async function hydrateProducts(ids: string[]) {
  if (ids.length === 0) return [];
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, ...VISIBLE_PRODUCT_WHERE },
    include: { variants: ACTIVE_VARIANT_WITH_STOCK, images: { orderBy: { position: "asc" } } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  // Preserve the ranked/sorted order the search query computed — a plain
  // `id IN (...)` fetch does not guarantee row order.
  return ids.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => p != null);
}

export async function searchProducts(params: SearchParams): Promise<SearchResult> {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(params.pageSize ?? DEFAULT_PAGE_SIZE)));
  const offset = (page - 1) * pageSize;
  const trimmedQuery = (params.query ?? "").trim();
  const sort = params.sort ?? "relevance";

  const filters = buildFilterFragments(params);
  const whereClause = Prisma.join(filters, " AND ");
  const scoreExpr = trimmedQuery
    ? Prisma.sql`
        COALESCE(ts_rank(p."searchVector", websearch_to_tsquery('english', ${expandSynonyms(trimmedQuery)})), 0)
        + COALESCE(similarity(p."title", ${trimmedQuery}), 0) * 0.3`
    : Prisma.sql`0`;

  const rows = await prisma.$queryRaw<Array<{ id: string; total_count: bigint }>>`
    SELECT p."id" AS id, COUNT(*) OVER() AS total_count
    FROM "products" p
    JOIN "sellers" s ON s."id" = p."sellerId"
    LEFT JOIN LATERAL (
      SELECT MIN(v."priceSantim") AS min_price FROM "variants" v WHERE v."productId" = p."id" AND v."active"
    ) prices ON true
    CROSS JOIN LATERAL (SELECT ${scoreExpr} AS score) scored
    WHERE ${whereClause}
    ORDER BY ${orderByClause(sort, Boolean(trimmedQuery))}
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  const total = rows.length > 0 ? Number(rows[0]!.total_count) : 0;
  const products = await hydrateProducts(rows.map((r) => r.id));

  const facetFilters = buildFilterFragments(params, { excludeBrandFilter: true });
  const facetWhere = Prisma.join(facetFilters, " AND ");
  const brandRows = await prisma.$queryRaw<Array<{ brand: string; count: bigint }>>`
    SELECT p."brand" AS brand, COUNT(*) AS count
    FROM "products" p
    JOIN "sellers" s ON s."id" = p."sellerId"
    WHERE ${facetWhere} AND p."brand" IS NOT NULL
    GROUP BY p."brand"
    ORDER BY count DESC, brand ASC
    LIMIT 20
  `;

  return {
    products,
    total,
    page,
    pageSize,
    brandFacets: brandRows.map((r) => ({ brand: r.brand, count: Number(r.count) })),
  };
}

export interface AutocompleteSuggestion {
  readonly slug: string;
  readonly title: string;
}

/** Fast prefix/fuzzy title suggestions for a search-as-you-type box —
 * intentionally lightweight: no facets, no pagination, just a short ranked
 * list, backed by the same trigram index searchProducts falls back to. */
export async function autocompleteProducts(prefix: string, limit = 8): Promise<AutocompleteSuggestion[]> {
  const trimmed = prefix.trim();
  if (trimmed.length < 2) return [];

  const rows = await prisma.$queryRaw<Array<{ slug: string; title: string }>>`
    SELECT p."slug" AS slug, p."title" AS title
    FROM "products" p
    JOIN "sellers" s ON s."id" = p."sellerId"
    WHERE p."status" = 'ACTIVE' AND s."status" = 'APPROVED'
      AND (p."title" ILIKE ${trimmed + "%"} OR similarity(p."title", ${trimmed}) > ${TRIGRAM_SIMILARITY_THRESHOLD})
    ORDER BY similarity(p."title", ${trimmed}) DESC, p."title" ASC
    LIMIT ${Math.min(20, Math.max(1, limit))}
  `;
  return rows;
}
