import type { MetadataRoute } from "next";
import {
  listCollections,
  listProductSlugsForSitemap,
  listSellerSlugsForSitemap,
} from "@/server/catalogue/catalogue-service";

// Computed per-request against live data, not frozen at build time — a
// product going out of stock, a seller being suspended, or a new listing
// going live must be reflected the next time a crawler fetches this, not
// only on the next deploy. Same reasoning as every other
// `dynamic = "force-dynamic"` page in this codebase that reads the catalogue.
export const dynamic = "force-dynamic";

const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [products, sellers, collections] = await Promise.all([
    listProductSlugsForSitemap(),
    listSellerSlugsForSitemap(),
    listCollections(),
  ]);

  const staticEntries: MetadataRoute.Sitemap = [
    { url: APP_URL, changeFrequency: "daily", priority: 1 },
    { url: `${APP_URL}/shop`, changeFrequency: "daily", priority: 0.9 },
    { url: `${APP_URL}/search`, changeFrequency: "daily", priority: 0.5 },
  ];

  const collectionEntries: MetadataRoute.Sitemap = collections.map((c) => ({
    url: `${APP_URL}/collections/${c.slug}`,
    changeFrequency: "daily",
    priority: 0.7,
  }));

  const productEntries: MetadataRoute.Sitemap = products.map((p) => ({
    url: `${APP_URL}/products/${p.slug}`,
    lastModified: p.updatedAt,
    changeFrequency: "daily",
    priority: 0.8,
  }));

  const sellerEntries: MetadataRoute.Sitemap = sellers.map((s) => ({
    url: `${APP_URL}/sellers/${s.slug}`,
    lastModified: s.updatedAt,
    changeFrequency: "weekly",
    priority: 0.6,
  }));

  return [...staticEntries, ...collectionEntries, ...productEntries, ...sellerEntries];
}
