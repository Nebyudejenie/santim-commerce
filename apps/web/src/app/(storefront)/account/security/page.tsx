import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guard";
import { ChangePasswordForm } from "@/components/change-password-form";
import { DeleteAccountForm } from "@/components/delete-account-form";

export const metadata: Metadata = { title: "Security" };
export const dynamic = "force-dynamic";

export default async function AccountSecurityPage() {
  await requireUser();

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "460px" }}>
      <div className="section-head">
        <h2>Password</h2>
      </div>
      <p className="form-hint" style={{ marginBottom: "var(--space-6)" }}>
        Changing your password signs you out of every device, including this one — you&apos;ll need to
        sign back in with your new password.
      </p>

      <ChangePasswordForm />

      <div className="section-head" style={{ marginTop: "var(--space-8)" }}>
        <h2>Your data</h2>
      </div>
      <p className="form-hint" style={{ marginBottom: "var(--space-4)" }}>
        Download a copy of your profile, addresses, orders, reviews, wishlist, and questions you&apos;ve
        asked, as a single file.
      </p>
      <a href="/account/data-export" className="btn btn--secondary" style={{ marginBottom: "var(--space-6)", display: "inline-block" }}>
        Download my data
      </a>

      <div className="section-head" style={{ marginTop: "var(--space-8)" }}>
        <h2 style={{ color: "var(--danger)" }}>Danger zone</h2>
      </div>
      <p className="form-hint" style={{ marginBottom: "var(--space-6)" }}>
        Deleting your account is permanent. Your name, email, and phone number are removed; past orders
        stay on record for accounting purposes. If you run an active store, contact support to close it
        first. Consider <Link href="/account/data-export">downloading your data</Link> before you do.
      </p>

      <DeleteAccountForm />
    </div>
  );
}
