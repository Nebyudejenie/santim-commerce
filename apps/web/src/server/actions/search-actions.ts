"use server";

/**
 * Autocomplete is a plain callable Server Action, not a `useActionState`
 * form action — the search bar calls it directly, debounced, from an
 * `onChange` handler, which is exactly what a Server Action is for beyond
 * form submission. No authorization check needed: this reads only publicly
 * visible product titles, the same data any anonymous storefront visitor
 * already sees on /shop.
 */

import { autocompleteProducts, type AutocompleteSuggestion } from "../search/search-service.js";

export async function autocompleteAction(prefix: string): Promise<AutocompleteSuggestion[]> {
  return autocompleteProducts(prefix);
}
