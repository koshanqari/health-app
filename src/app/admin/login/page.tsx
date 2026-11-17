import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";

export const metadata = { title: "Administrator sign in" };

export default function AdminLoginPage() {
  return <AuthShell mode="admin"><AuthForm mode="admin" /></AuthShell>;
}
