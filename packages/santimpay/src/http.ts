/**
 * HTTP transport: deadlines, bounded retries, full jitter.
 *
 * The vendor SDK calls `axios.post(...)` with no timeout. Node's default is no
 * timeout at all, so a hung TCP connection to the gateway holds a request
 * handler — and, in a serverless deployment, a billed invocation — open
 * indefinitely. Under load, that is how a slow dependency turns into a total
 * outage: every worker ends up parked on the same dead socket.
 *
 * Three rules this file enforces:
 *   1. Every outbound call has a deadline.
 *   2. Retries are bounded, exponential, and jittered.
 *   3. Only transport-level failures and 5xx/429 are retried. A business
 *      decline is a decision, not a fault, and repeating it just burns budget.
 */

import {
  SantimPayHttpError,
  SantimPayNetworkError,
  SantimPayTimeoutError,
  type SantimPayErrorContext,
} from "./errors.js";

export interface RetryPolicy {
  /** Number of attempts AFTER the first. 2 means up to 3 total calls. */
  readonly maxRetries: number;
  /** First backoff step in ms; doubles each attempt. */
  readonly baseDelayMs: number;
  /** Ceiling for a single backoff step. */
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

/**
 * "Full jitter" backoff (AWS Architecture Blog). A fixed backoff makes every
 * client that failed at the same instant retry at the same instant — the
 * thundering herd that keeps a recovering service down. Randomising the whole
 * interval spreads the load flat.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export interface HttpOptions {
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
  readonly gatewayToken?: string | undefined;
  readonly userAgent: string;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests, so retry logic does not actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function postJson<T>(
  url: string,
  body: unknown,
  options: HttpOptions,
  context: SantimPayErrorContext = {},
): Promise<T> {
  return request<T>("POST", url, body, options, context);
}

export async function getJson<T>(
  url: string,
  options: HttpOptions,
  context: SantimPayErrorContext = {},
): Promise<T> {
  return request<T>("GET", url, undefined, options, context);
}

async function request<T>(
  method: "GET" | "POST",
  url: string,
  body: unknown,
  options: HttpOptions,
  context: SantimPayErrorContext,
): Promise<T> {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const { retry } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
    try {
      return await attemptOnce<T>(method, url, body, options, doFetch, context);
    } catch (err) {
      lastError = err as Error;

      const retryable = err instanceof SantimPayNetworkError
        || err instanceof SantimPayTimeoutError
        || (err instanceof SantimPayHttpError && err.retryable);

      if (!retryable || attempt === retry.maxRetries) throw err;

      const delayMs = backoffDelay(attempt, retry);
      options.onRetry?.({ attempt: attempt + 1, delayMs, error: lastError });
      await sleep(delayMs);
    }
  }

  /* c8 ignore next */
  throw lastError ?? new SantimPayNetworkError("request failed with no error recorded", undefined, context);
}

async function attemptOnce<T>(
  method: "GET" | "POST",
  url: string,
  body: unknown,
  options: HttpOptions,
  doFetch: typeof fetch,
  context: SantimPayErrorContext,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": options.userAgent,
  };
  if (method === "POST") headers["Content-Type"] = "application/json";
  // PDF p.5: "Gateway token shall be provided on the header as bearer token".
  // The vendor SDK has this commented out on every call; we do not.
  if (options.gatewayToken) headers["Authorization"] = `Bearer ${options.gatewayToken}`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new SantimPayTimeoutError(options.timeoutMs, context);
    }
    throw new SantimPayNetworkError(
      `Cannot reach SantimPay at ${url}: ${(err as Error).message}`,
      err,
      context,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  if (!response.ok) {
    throw new SantimPayHttpError(response.status, text, context);
  }

  if (text.trim() === "") return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SantimPayHttpError(
      response.status,
      `expected JSON, received: ${text.slice(0, 200)}`,
      context,
    );
  }
}
