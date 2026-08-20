import Link from "next/link";
import type { Metadata } from "next";
import { ProductCard } from "@/components/product-card";
import { searchProducts, type SearchSort } from "@/server/search/search-service";
import { birr, MoneyError } from "@santim/santimpay";

interface SearchPageProps {
  searchParams: Promise<{
    q?: string;
    brand?: string;
    minPrice?: string;
    maxPrice?: string;
    sort?: string;
    page?: string;
  }>;
}

export async function generateMetadata({ searchParams }: SearchPageProps): Promise<Metadata> {
  const { q } = await searchParams;
  return { title: q ? `"${q}"` : "Search" };
}

function parsePriceBirr(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  try {
    return birr(Number(raw));
  } catch (error) {
    if (error instanceof MoneyError) return undefined;
    throw error;
  }
}

const SORT_OPTIONS: ReadonlyArray<{ value: SearchSort; label: string }> = [
  { value: "relevance", label: "Best match" },
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
];

/** Builds a /search href preserving every current param except the ones
 * being overridden — every filter/sort/page control is a real link, so the
 * whole page is bookmarkable and works with JS disabled. */
function buildHref(current: Record<string, string | undefined>, overrides: Record<string, string | undefined>) {
  const merged = { ...current, ...overrides };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `/search?${qs}` : "/search";
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const query = params.q ?? "";
  const page = Math.max(1, Number(params.page) || 1);
  const sort = (["relevance", "newest", "price_asc", "price_desc"].includes(params.sort ?? "")
    ? params.sort
    : "relevance") as SearchSort;

  const result = await searchProducts({
    query,
    brand: params.brand,
    minPriceSantim: parsePriceBirr(params.minPrice),
    maxPriceSantim: parsePriceBirr(params.maxPrice),
    sort,
    page,
  });

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const currentParams = { q: params.q, brand: params.brand, minPrice: params.minPrice, maxPrice: params.maxPrice, sort: params.sort };

  return (
    <div className="container search-page" style={{ paddingBlock: "var(--space-7)" }}>
      <div className="section-head">
        <h2>{query ? `Results for "${query}"` : "Search"}</h2>
        <p className="section-head__meta">
          {result.total} {result.total === 1 ? "product" : "products"}
        </p>
      </div>

      <div className="search-page__layout">
        <aside className="search-page__filters">
          <div className="filter-group">
            <h3>Sort</h3>
            <ul>
              {SORT_OPTIONS.map((opt) => (
                <li key={opt.value}>
                  <Link
                    href={buildHref(currentParams, { sort: opt.value === "relevance" ? undefined : opt.value, page: undefined })}
                    aria-current={sort === opt.value ? "true" : undefined}
                    className={sort === opt.value ? "filter-link filter-link--active" : "filter-link"}
                  >
                    {opt.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {result.brandFacets.length > 0 && (
            <div className="filter-group">
              <h3>Brand</h3>
              <ul>
                {params.brand && (
                  <li>
                    <Link href={buildHref(currentParams, { brand: undefined, page: undefined })} className="filter-link">
                      Clear
                    </Link>
                  </li>
                )}
                {result.brandFacets.map((facet) => (
                  <li key={facet.brand}>
                    <Link
                      href={buildHref(currentParams, {
                        brand: params.brand === facet.brand ? undefined : facet.brand,
                        page: undefined,
                      })}
                      aria-current={params.brand === facet.brand ? "true" : undefined}
                      className={params.brand === facet.brand ? "filter-link filter-link--active" : "filter-link"}
                    >
                      {facet.brand} <span className="filter-link__count">{facet.count}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <form className="filter-group" action="/search" method="get">
            <h3>Price (ETB)</h3>
            {query && <input type="hidden" name="q" value={query} />}
            {params.brand && <input type="hidden" name="brand" value={params.brand} />}
            {params.sort && <input type="hidden" name="sort" value={params.sort} />}
            <div className="filter-price-inputs">
              <input type="number" name="minPrice" placeholder="Min" defaultValue={params.minPrice} min="0" step="1" />
              <input type="number" name="maxPrice" placeholder="Max" defaultValue={params.maxPrice} min="0" step="1" />
            </div>
            <button type="submit" className="btn btn--secondary btn-sm" style={{ marginTop: "var(--space-3)" }}>
              Apply
            </button>
          </form>
        </aside>

        <div className="search-page__results">
          {result.products.length === 0 ? (
            <div className="empty-state">
              <h2>No products found</h2>
              <p>Try a different search term or clear your filters.</p>
            </div>
          ) : (
            <>
              <div className="product-grid">
                {result.products.map((product, i) => (
                  <ProductCard key={product.id} product={product} index={i} />
                ))}
              </div>

              {totalPages > 1 && (
                <nav className="pagination" aria-label="Search results pages">
                  {page > 1 && (
                    <Link href={buildHref(currentParams, { page: String(page - 1) })} className="btn btn--secondary btn-sm">
                      Previous
                    </Link>
                  )}
                  <span className="pagination__status">
                    Page {page} of {totalPages}
                  </span>
                  {page < totalPages && (
                    <Link href={buildHref(currentParams, { page: String(page + 1) })} className="btn btn--secondary btn-sm">
                      Next
                    </Link>
                  )}
                </nav>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
