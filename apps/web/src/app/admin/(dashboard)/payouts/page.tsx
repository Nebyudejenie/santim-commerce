import Link from "next/link";
import type { Metadata } from "next";
import { listSellersWithPayableBalance } from "@/server/orders/settlement-service";
import { RecordPayoutButton } from "@/components/record-payout-button";

export const metadata: Metadata = { title: "Payouts" };
export const dynamic = "force-dynamic";

function formatBirr(santim: number): string {
  return (santim / 100).toFixed(2);
}

export default async function AdminPayoutsPage() {
  const sellers = await listSellersWithPayableBalance();

  return (
    <div>
      <div className="admin-header">
        <h1>Payouts</h1>
      </div>
      <p className="form-hint" style={{ marginBottom: "var(--space-5)" }}>
        Real seller payouts (sending real money automatically) are not built — see this project&apos;s own
        docs on why. This records what you&apos;ve already paid a seller through your own real process
        (bank transfer, mobile money) so the ledger reflects reality; it never sends any payment itself.
      </p>

      {sellers.length === 0 ? (
        <p className="empty-note">No sellers currently have an outstanding balance.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Store</th>
              <th>Owed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sellers.map((s) => (
              <tr key={s.sellerId}>
                <td><Link href={`/sellers/${s.slug}`}>{s.storeName}</Link></td>
                <td>{formatBirr(s.payableSantim)} ETB</td>
                <td>
                  <RecordPayoutButton sellerId={s.sellerId} storeName={s.storeName} payableBirr={formatBirr(s.payableSantim)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
