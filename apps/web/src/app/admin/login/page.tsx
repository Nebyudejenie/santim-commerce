import type { Metadata } from "next";
import { AdminLoginForm } from "@/components/admin-login-form";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default function AdminLoginPage() {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>LUMEN Admin</h1>
        <p className="auth-card__subtitle">Staff sign-in. Customer accounts cannot access this area.</p>
        <AdminLoginForm />
      </div>
    </div>
  );
}
