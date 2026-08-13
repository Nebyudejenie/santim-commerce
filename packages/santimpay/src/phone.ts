/**
 * Ethiopian MSISDN normalisation.
 *
 * SantimPay rejects anything that is not exactly `+251XXXXXXXXX` with:
 *   {"message":"phone number must be in the format +251912345678","status":"declined"}
 *
 * Customers, however, type: 0912345678, 251912345678, +251 91 234 5678,
 * 0091-2345678, and every other variation. Normalising at OUR boundary — not
 * hoping the customer is disciplined — is what keeps that decline out of
 * production. This is a general principle: validate and canonicalise foreign
 * input at the edge, then let the interior of the system assume it is clean.
 */

export class PhoneNumberError extends Error {
  override name = "PhoneNumberError";
  constructor(readonly input: string, message: string) {
    super(message);
  }
}

/** Mobile network prefixes in use: 9 = Ethio Telecom, 7 = Safaricom Ethiopia. */
const MOBILE_PREFIXES = ["9", "7"] as const;

/**
 * Normalise any common Ethiopian mobile format to E.164 (`+2519XXXXXXXX`).
 * Throws rather than guessing — a wrong number sends money to a stranger.
 */
export function normalizeEthiopianMsisdn(input: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new PhoneNumberError(String(input), "phone number is empty");
  }

  // Strip everything that is not a digit or a leading plus.
  let digits = input.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);

  // 00 international prefix → drop it.
  if (digits.startsWith("00")) digits = digits.slice(2);

  let national: string;
  if (digits.startsWith("251")) {
    national = digits.slice(3);
  } else if (digits.startsWith("0")) {
    national = digits.slice(1);
  } else {
    national = digits;
  }

  if (national.length !== 9) {
    throw new PhoneNumberError(
      input,
      `expected 9 national digits after the country code, got ${national.length} ("${national}")`,
    );
  }

  const prefix = national[0]!;
  if (!MOBILE_PREFIXES.includes(prefix as (typeof MOBILE_PREFIXES)[number])) {
    throw new PhoneNumberError(
      input,
      `"${prefix}" is not an Ethiopian mobile prefix (expected 9 or 7)`,
    );
  }

  return `+251${national}`;
}

/** Non-throwing variant for form validation. */
export function isValidEthiopianMsisdn(input: string): boolean {
  try {
    normalizeEthiopianMsisdn(input);
    return true;
  } catch {
    return false;
  }
}

/** Mask for logs and support screens: +2519****5678 */
export function maskMsisdn(e164: string): string {
  if (e164.length < 8) return "***";
  return `${e164.slice(0, 5)}****${e164.slice(-4)}`;
}
