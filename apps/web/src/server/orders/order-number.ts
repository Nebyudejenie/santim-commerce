/**
 * Human-facing order numbers.
 *
 * The primary key (`cuid()`) is for the database and the URL; nobody reads it
 * over the phone. Support, SMS receipts, and the customer's own memory need
 * something short, unambiguous when spoken aloud, and typo-resistant.
 *
 * Format: SC-XXXXXXXX using Crockford's Base32 (excludes I, L, O, U — the
 * letters most often confused with 1, 1, 0, and V when read aloud or misheard
 * on a phone call to support).
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32, no I L O U

export function generateOrderNumber(random: () => number = Math.random): string {
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return `SC-${suffix}`;
}

/** Loose format check for UI input (order lookup forms). Not a checksum. */
export function isPlausibleOrderNumber(value: string): boolean {
  return /^SC-[0-9A-HJKMNP-TV-Z]{8}$/.test(value.trim().toUpperCase());
}
