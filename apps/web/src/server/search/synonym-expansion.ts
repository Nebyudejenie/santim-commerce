/**
 * A deliberately small, honest synonym layer — not a claim of general
 * synonym support. Only expands when the WHOLE trimmed query matches one
 * term in a curated group exactly; a multi-word query passes through
 * unchanged (websearch_to_tsquery's own AND/phrase/exclusion handling is
 * already the right behavior there — see search-service.ts).
 *
 * Zero imports — same real constraint as seller-state-machine.ts:
 * `test:unit` runs under plain `node --experimental-strip-types`.
 */

const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["tv", "television"],
  ["phone", "smartphone", "mobile"],
  ["sneaker", "sneakers", "trainer", "trainers", "runner", "runners"],
  ["jacket", "coat"],
  ["tee", "t-shirt", "tshirt"],
  ["trouser", "trousers", "pants"],
  ["bag", "backpack"],
];

/**
 * Rewrites a single recognized term into `"term1 OR term2 OR term3"` — the
 * exact grammar `websearch_to_tsquery` supports at the top level (it has no
 * parenthesized grouping, so this only works because the whole query is
 * being replaced, not a sub-term nested inside a longer phrase).
 */
export function expandSynonyms(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();
  const group = SYNONYM_GROUPS.find((g) => g.includes(lower));
  if (!group) return trimmed;

  return group.join(" OR ");
}
