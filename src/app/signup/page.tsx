import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";

export const metadata = { title: "Create your account" };

export default function SignupPage() {
  return <AuthShell mode="signup"><AuthForm mode="signup" /></AuthShell>;
}
