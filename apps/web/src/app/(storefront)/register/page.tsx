import Link from "next/link";
import type { Metadata } from "next";
import { RegisterForm } from "@/components/register-form";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default function RegisterPage() {
  return (
    <div className="container auth-page">
      <div className="auth-card">
        <h1>Create your account</h1>
        <p className="auth-card__subtitle">Faster checkout, order history, and saved details.</p>
        <RegisterForm />
        <p className="auth-card__footer">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
