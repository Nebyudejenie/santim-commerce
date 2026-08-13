/**
 * Pre-signs a batch of realistic SantimPay webhook callbacks for load
 * testing `/api/webhooks/santimpay`.
 *
 * WHY PRE-SIGNED, NOT SIGNED INLINE BY k6
 * k6 scripts run in goja, a JS runtime with no ES256/ECDSA signing support
 * out of the box (that would require a custom xk6 build with a crypto
 * extension). Signing here, with the SAME `signES256` this codebase uses
 * for real, and just REPLAYING the results from k6, keeps the load test
 * honest — every payload k6 sends is a genuinely valid signature, not an
 * approximation — while staying on the vanilla k6 binary.
 *
 * FRESHNESS: each payload's `generated` timestamp is fixed at generation
 * time, and verifyWebhook() enforces WEBHOOK_MAX_AGE_SECONDS (default 300s).
 * Regenerate this fixture immediately before a run, or point the target
 * server's WEBHOOK_MAX_AGE_SECONDS at a larger value for a long load test —
 * documented in this suite's README, not silently worked around here.
 *
 * Usage:
 *   pnpm exec tsx scripts/generate-webhook-fixtures.ts [count]
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { signES256 } from "@santim/santimpay";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COUNT = Number(process.argv[2] ?? 500);

// The SAME testbed-only key pattern used throughout this project's local
// verification steps (see docs/01-santimpay-protocol-spec.md and the
// vendor SDK's own published example) — never production.
const PRIVATE_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEILd62Ot4hMSxIwO1TRZQnAD02FHV5Hxvc7PbHU3nWQWwoAoGCCqGSM49
AwEHoUQDQgAEBy11auaVru1GUhPavhEub2tfx8P6EvdVnq+BL/fDEe83IwgOrkvg
bTa6BEUQkKoqsn+8bpJ3BIYAI2Iqa+KzZw==
-----END EC PRIVATE KEY-----`;

const MERCHANT_ID = "9e2dab64-e2bb-4837-9b85-d855dd878d2b";

interface Fixture {
  body: string;
  signedToken: string;
}

function buildFixture(index: number): Fixture {
  const generated = Math.floor(Date.now() / 1000);
  const txnId = `loadtest-gw-${index}-${generated}`;
  const thirdPartyId = `loadtest-merchant-${index}-${generated}`;

  const body = {
    txnId,
    thirdPartyId,
    merId: MERCHANT_ID,
    amount: "19.99",
    currency: "ETB",
    status: "COMPLETED",
    message: "payment successful",
    paymentVia: "Telebirr",
    refId: `bank-ref-${index}`,
    created_at: new Date().toISOString(),
  };

  const signedToken = signES256({ txnId, thirdPartyId, generated }, PRIVATE_KEY);

  return { body: JSON.stringify(body), signedToken };
}

const fixtures = Array.from({ length: COUNT }, (_, i) => buildFixture(i));
const fixturePath = join(__dirname, "../../../infra/load-testing/fixtures/webhook-payloads.json");
writeFileSync(fixturePath, JSON.stringify(fixtures));
console.log(`Generated ${fixtures.length} signed webhook fixtures -> ${fixturePath}`);
