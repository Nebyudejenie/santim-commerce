import Link from "next/link";
import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/reset-password-form";

export const metadata: Metadata = { title: "Reset password" };
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function ResetPasswordPage({ params }: Props) {
  const { token } = await params;

  return (
    <div className="container auth-page">
      <div className="auth-card">
        <h1>Reset your password</h1>
        <p className="auth-card__subtitle">Choose a new password for your account.</p>
        <ResetPasswordForm token={token} />
        <p className="auth-card__footer">
          <Link href="/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
