/**
 * Structured logging.
 *
 * Two rules that matter more than the library you pick:
 *
 *  1. LOG JSON, NOT PROSE. `logger.info("payment completed", { orderId })` is
 *     queryable in Loki/CloudWatch. `console.log("payment completed for " + id)`
 *     is not, and at 3am you will be writing regexes instead of fixing things.
 *
 *  2. REDACT AT THE LOGGER, NOT AT THE CALL SITE. Anyone can forget on one
 *     line. A private key or a full MSISDN in a log aggregator is a breach that
 *     survives in backups long after you delete the line.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEYS = [
  "privatekey", "private_key", "signedtoken", "signed_token", "authorization",
  "password", "passwordhash", "sessionsecret", "gatewaytoken", "secret", "token",
];

const MSISDN = /(\+251)(\d{1})(\d{4})(\d{4})/g;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "string") return value.replace(MSISDN, "$1$2****$4");
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = REDACT_KEYS.includes(key.toLowerCase()) ? "[redacted]" : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

function threshold(): number {
  return LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;
}

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold()) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(redact(fields) as Record<string, unknown>),
  };
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
