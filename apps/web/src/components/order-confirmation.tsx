"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Money } from "./money";

type OrderStatus = "PENDING_PAYMENT" | "PAID" | "FAILED" | "CANCELLED" | "REFUNDED" | "PARTIALLY_REFUNDED";

interface StatusResponse {
  orderNumber: string;
  status: OrderStatus;
  totalSantim: number;
  paid: boolean;
}

const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS = 100; // ~5 minutes — matches the worker's poll window order of magnitude

/**
 * Client-side confirmation.
 *
 * WHY THIS EXISTS AT ALL: the browser's redirect back from SantimPay's hosted
 * page is not proof of payment — see docs/01-santimpay-protocol-spec.md §5.2.
 * This component NEVER trusts the redirect; it polls our own
 * `/api/orders/:orderNumber/status`, which reflects only what the webhook +
 * poller + reconciler have confirmed against the Transaction Status API. If
 * the customer closes this tab, the order still resolves correctly server-side
 * — this UI is a courtesy, not part of the correctness story.
 */
export function OrderConfirmation({ initial }: { initial: StatusResponse }) {
  const [data, setData] = useState(initial);
  const pollCount = useRef(0);
  const stopped = useRef(false);

  useEffect(() => {
    if (data.status !== "PENDING_PAYMENT") return;

    let cancelled = false;

    async function poll() {
      if (cancelled || stopped.current) return;
      if (pollCount.current >= MAX_POLLS) {
        stopped.current = true;
        return;
      }
      pollCount.current += 1;

      try {
        const res = await fetch(`/api/orders/${data.orderNumber}/status`, { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as StatusResponse;
          if (!cancelled) setData(next);
          if (next.status === "PENDING_PAYMENT") {
            setTimeout(poll, POLL_INTERVAL_MS);
          }
        } else {
          setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch {
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    const handle = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [data.status, data.orderNumber]);

  if (data.status === "PAID") {
    return (
      <div className="status-page">
        <div className="status-page__icon status-page__icon--success">
          <CheckIcon />
        </div>
        <h1>Payment confirmed</h1>
        <p className="order-number-pill">{data.orderNumber}</p>
        <p>
          Thank you — your order for <Money santim={data.totalSantim} /> is confirmed. A receipt has
          been sent to your email.
        </p>
        <Link href="/shop" className="btn btn--primary btn--lg">Continue shopping</Link>
      </div>
    );
  }

  if (data.status === "FAILED" || data.status === "CANCELLED") {
    return (
      <div className="status-page">
        <div className="status-page__icon status-page__icon--error">
          <CrossIcon />
        </div>
        <h1>{data.status === "CANCELLED" ? "Payment cancelled" : "Payment failed"}</h1>
        <p className="order-number-pill">{data.orderNumber}</p>
        <p>Your order was not charged. You can try again with a different payment method.</p>
        <Link href="/cart" className="btn btn--primary btn--lg">Back to your bag</Link>
      </div>
    );
  }

  const timedOut = pollCount.current >= MAX_POLLS;

  return (
    <div className="status-page">
      <div className="status-page__icon status-page__icon--pending">
        <span className="spinner" role="status" aria-label="Confirming payment" />
      </div>
      <h1>{timedOut ? "Still confirming…" : "Confirming your payment"}</h1>
      <p className="order-number-pill">{data.orderNumber}</p>
      <p>
        {timedOut
          ? "This is taking longer than usual — some payment channels take a few minutes to confirm. We'll email your receipt the moment it clears; you can safely close this page."
          : "Hang tight — some payment channels (especially bank transfers) can take a minute to confirm."}
      </p>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
