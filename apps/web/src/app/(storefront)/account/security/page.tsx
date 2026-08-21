import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guard";
import { ChangePasswordForm } from "@/components/change-password-form";

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
    </div>
  );
}
