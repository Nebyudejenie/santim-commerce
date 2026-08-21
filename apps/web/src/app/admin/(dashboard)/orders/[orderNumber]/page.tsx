import { notFound } from "next/navigation";
import { getOrderDetail } from "@/server/admin/admin-queries";
import { StatusPill } from "@/components/status-pill";
import { Money } from "@/components/money";
import { ResettleButton } from "@/components/resettle-button";

interface Props {
  params: Promise<{ orderNumber: string }>;
}

const UNRESOLVED = new Set(["CREATED", "PENDING", "EXPIRED"]);

export default async function AdminOrderDetailPage({ params }: Props) {
  const { orderNumber } = await params;
  const order = await getOrderDetail(orderNumber);
  if (!order) notFound();

  return (
    <div>
      <div className="admin-header">
        <div>
          <h1>{order.orderNumber}</h1>
          <p style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>{order.email} · {order.phone}</p>
        </div>
        <StatusPill status={order.status} />
      </div>

      <div className="detail-grid">
        <div>
          <div className="detail-card">
            <h3>Line items</h3>
            <table className="admin-table">
              <thead>
                <tr><th>Item</th><th>SKU</th><th>Qty</th><th>Total</th></tr>
              </thead>
              <tbody>
                {order.lines.map((line) => (
                  <tr key={line.id}>
                    <td>{line.productTitle} · {line.variantTitle}</td>
                    <td>{line.sku}</td>
                    <td>{line.quantity}</td>
                    <td><Money santim={line.lineTotalSantim} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: "var(--space-4)", textAlign: "right", fontWeight: 700 }}>
              Total: <Money santim={order.totalSantim} />
            </div>
          </div>

          <div className="detail-card">
            <h3>Payment attempts</h3>
            {order.payments.length === 0 ? (
              <p className="empty-note">No payment attempts yet.</p>
            ) : (
              order.payments.map((payment) => (
                <div key={payment.id} style={{ marginBottom: "var(--space-5)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-2)" }}>
                    <code style={{ fontSize: "var(--text-xs)" }}>{payment.merchantTxnId}</code>
                    <StatusPill status={payment.status} />
                  </div>
                  <p style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)" }}>
                    {payment.channel ?? "Channel unknown"}
                    {payment.channelRef && <> · ref {payment.channelRef}</>}
                    {payment.gatewayTxnId && <> · gateway id {payment.gatewayTxnId}</>}
                  </p>
                  {payment.failureMessage && (
                    <p className="alert alert--error" style={{ marginTop: "var(--space-2)" }}>
                      {payment.failureMessage}
                    </p>
                  )}
                  {UNRESOLVED.has(payment.status) && (
                    <div style={{ marginTop: "var(--space-3)" }}>
                      <ResettleButton merchantTxnId={payment.merchantTxnId} orderNumber={order.orderNumber} />
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="detail-card">
          <h3>Order timeline</h3>
          {order.events.length === 0 ? (
            <p className="empty-note">No events recorded.</p>
          ) : (
            order.events.map((event) => (
              <div key={event.id} className="event-row">
                <div>
                  <div>{event.type}</div>
                  {event.message && <div style={{ color: "var(--fg-muted)" }}>{event.message}</div>}
                  <div style={{ color: "var(--fg-faint)" }}>via {event.actor}</div>
                </div>
                <time dateTime={event.createdAt.toISOString()}>
                  {event.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                </time>
              </div>
            ))
          )}
        </div>

        {order.customerNote && (
          <div className="detail-card">
            <h3>Delivery notes from the buyer</h3>
            <p style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)", whiteSpace: "pre-wrap" }}>{order.customerNote}</p>
          </div>
        )}
      </div>
    </div>
  );
}
