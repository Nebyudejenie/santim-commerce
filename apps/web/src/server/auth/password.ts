/**
 * Password hashing — scrypt, from Node's built-in `node:crypto`.
 *
 * WHY NOT bcrypt/argon2
 * ----------------------
 * Both are the more commonly recommended choices, and both ship as native
 * addons requiring compilation (node-gyp) — which means a C toolchain in
 * every environment that runs `pnpm install`, including this project's
 * multi-stage Docker build (see infra/docker/Dockerfile), and a matching
 * prebuilt binary for whatever exact Node/OS/arch combination each
 * environment happens to be. `scrypt` is a memory-hard KDF built into Node
 * itself: OWASP-acceptable, zero extra dependencies, zero native-binding
 * fragility. If this project later needs Argon2id specifically (the current
 * OWASP first choice), swap this one module — nothing above it changes,
 * because the rest of the app only ever calls `hashPassword`/`verifyPassword`.
 *
 * FORMAT: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` — the KDF parameters are
 * embedded in the stored hash itself, so tuning them later (as hardware gets
 * faster) does not invalidate passwords hashed under the old parameters; new
 * logins re-hash on the new parameters (see `needsRehash`).
 */

import crypto from "node:crypto";

interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

const KEY_LENGTH = 64;
const CURRENT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 }; // ~16MB, ~50-100ms on typical hardware

export class PasswordError extends Error {
  override name = "PasswordError";
}

// `params` is deliberately the general ScryptParams shape, not
// `typeof CURRENT_PARAMS` — verifyPassword() parses whatever N/r/p were
// embedded in a POSSIBLY OLDER stored hash (see needsRehash) and must be
// able to pass those through, not just today's constant.
function scrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, params, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) {
    throw new PasswordError("Password must be at least 10 characters.");
  }
  if (password.length > 256) {
    // Not a strength rule — a bound on how much CPU an attacker can make us
    // spend hashing an absurdly long string on a public registration form.
    throw new PasswordError("Password is too long.");
  }

  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, CURRENT_PARAMS);
  const { N, r, p } = CURRENT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const params = { N: Number(nStr), r: Number(rStr), p: Number(pStr) };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return false;
  }

  const salt = Buffer.from(saltHex!, "hex");
  const expected = Buffer.from(hashHex!, "hex");

  const derived = await scrypt(password, salt, params);

  // Buffers of different length: crypto.timingSafeEqual throws rather than
  // returning false, so guard the length first — still not a data-dependent
  // branch on the SECRET itself, only on lengths derived from stored params.
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/** True if a successfully-verified password was hashed under outdated params. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  const [, nStr, rStr, pStr] = parts;
  return (
    Number(nStr) !== CURRENT_PARAMS.N ||
    Number(rStr) !== CURRENT_PARAMS.r ||
    Number(pStr) !== CURRENT_PARAMS.p
  );
}
