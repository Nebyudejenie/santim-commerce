import Link from "next/link";
import { listStuckPayments } from "@/server/admin/admin-queries";
import { StatusPill } from "@/components/status-pill";
import { Money } from "@/components/money";
import { ResettleButton } from "@/components/resettle-button";

// See admin/page.tsx's comment: no searchParams/route param here to force
// dynamic rendering automatically, and a stale reconciliation queue is worse
// than useless — it would show payments as "stuck" long after they resolved,
// or hide genuinely new stuck payments entirely.
export const dynamic = "force-dynamic";

/**
 * The human-facing side of docs/01-santimpay-protocol-spec.md §5.4's
 * "defence in depth" — the same stuck-payment population the background
 * worker's poller and nightly reconciler already work through automatically.
 * This page exists for the cases that need a human: an amount mismatch was
 * logged, a channel is having a bad day, or someone just wants to see for
 * themselves before an anxious customer's chat message turns into an escalation.
 */
export default async function ReconciliationPage() {
  const stuck = await listStuckPayments(20);

  return (
    <div>
      <div className="admin-header">
        <h1>Reconciliation queue</h1>
      </div>

      <p className="empty-note" style={{ marginBottom: "var(--space-5)" }}>
        Payment intents unresolved for more than 20 minutes. The background worker (src/worker/index.ts)
        polls these automatically on a backoff schedule and sweeps everything older than an hour every
        15 minutes — this list is for anything that still needs a human look.
      </p>

      {stuck.length === 0 ? (
        <p className="empty-note">Nothing stuck right now.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Transaction</th>
              <th>Status</th>
              <th>Amount</th>
              <th>Age</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {stuck.map((payment) => (
              <tr key={payment.id}>
                <td>
                  <Link href={`/admin/orders/${payment.order.orderNumber}`}>{payment.order.orderNumber}</Link>
                  <div style={{ color: "var(--fg-faint)", fontSize: "var(--text-xs)" }}>{payment.order.email}</div>
                </td>
                <td><code style={{ fontSize: "var(--text-xs)" }}>{payment.merchantTxnId}</code></td>
                <td><StatusPill status={payment.status} /></td>
                <td><Money santim={payment.amountSantim} /></td>
                <td>{formatAge(payment.createdAt)}</td>
                <td>
                  <ResettleButton merchantTxnId={payment.merchantTxnId} orderNumber={payment.order.orderNumber} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatAge(date: Date): string {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
