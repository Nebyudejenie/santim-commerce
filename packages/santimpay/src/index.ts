/**
 * @santim/santimpay — hardened SantimPay gateway client.
 *
 * Differences from the vendor SDK, all deliberate:
 *   - Gateway bearer token actually sent (vendor has it commented out)
 *   - Request deadlines + bounded, jittered retries (vendor has none)
 *   - `status: "declined"` on HTTP 200 detected and typed (vendor ignores it)
 *   - B2C signing-argument bug fixed (vendor shifts every argument by one)
 *   - Webhook signature verification with algorithm pinning (vendor: absent)
 *   - Money as integer santim, MSISDN normalisation, typed error taxonomy
 *   - No axios dependency; native fetch
 */

export {
  SantimPayClient,
  PRODUCTION_BASE_URL,
  TESTBED_BASE_URL,
  type SantimPayConfig,
  type SantimPayEnvironment,
  type CheckoutSessionInput,
  type DirectPaymentInput,
  type PayoutInput,
} from "./client.js";

export {
  SantimPayError,
  SantimPayDeclinedError,
  DuplicateReferenceError,
  SantimPayNetworkError,
  SantimPayTimeoutError,
  SantimPayHttpError,
  SantimPaySignatureError,
  SantimPayConfigError,
  classifyDecline,
  type DeclineCode,
  type SantimPayErrorContext,
} from "./errors.js";

export {
  verifyWebhook,
  assertAmountMatches,
  extractSignatureHeader,
  SIGNATURE_HEADER,
  type WebhookVerificationInput,
  type VerifiedWebhook,
} from "./webhook.js";

export {
  signES256,
  verifyES256,
  derivePublicKey,
  timingSafeEqual,
  generateTestKeyPair,
} from "./crypto.js";

export {
  normalizeTransaction,
  normalizeStatus,
  isTerminal,
  TERMINAL_STATUSES,
  type Transaction,
  type WireTransaction,
  type PaymentStatus,
  type WireStatus,
  type PayoutPartner,
} from "./types.js";

export {
  santim,
  birr,
  parseBirr,
  add,
  subtract,
  multiply,
  sum,
  allocate,
  applyRate,
  format,
  toGatewayAmount,
  fromGatewayAmount,
  MoneyError,
  ZERO,
  type Santim,
} from "./money.js";

export {
  normalizeEthiopianMsisdn,
  isValidEthiopianMsisdn,
  maskMsisdn,
  PhoneNumberError,
} from "./phone.js";

export {
  DEFAULT_RETRY,
  backoffDelay,
  type RetryPolicy,
} from "./http.js";
