import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guard";
import { listAddressesForUser } from "@/server/addresses/address-service";
import { AddressList } from "@/components/address-list";

export const metadata: Metadata = { title: "Your addresses" };
export const dynamic = "force-dynamic";

export default async function AddressesPage() {
  const user = await requireUser();
  const addresses = await listAddressesForUser(user.id);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "620px" }}>
      <div className="section-head">
        <h2>Your addresses</h2>
      </div>
      <p className="form-hint" style={{ marginBottom: "var(--space-6)" }}>
        Saved addresses can be picked at checkout instead of typing your details every time.
      </p>

      <AddressList
        addresses={addresses.map((a) => ({
          id: a.id,
          fullName: a.fullName,
          phone: a.phone,
          city: a.city,
          subCity: a.subCity,
          woreda: a.woreda,
          streetLine: a.streetLine,
          landmark: a.landmark,
          notes: a.notes,
        }))}
      />
    </div>
  );
}
