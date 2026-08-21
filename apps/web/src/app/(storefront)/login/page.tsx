import Link from "next/link";
import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ redirectTo?: string }>;
}

export default async function LoginPage({ searchParams }: Props) {
  const { redirectTo } = await searchParams;

  return (
    <div className="container auth-page">
      <div className="auth-card">
        <h1>Sign in</h1>
        <p className="auth-card__subtitle">Welcome back to LUMEN.</p>
        <LoginForm redirectTo={redirectTo} />
        <p className="auth-card__footer">
          New here? <Link href="/register">Create an account</Link>
        </p>
        <p className="form-hint" style={{ marginTop: "var(--space-3)" }}>
          Forgotten your password? Contact support with the email on your account to get back in.
        </p>
      </div>
    </div>
  );
}
