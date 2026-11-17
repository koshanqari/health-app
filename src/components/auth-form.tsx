"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

export function AuthForm({ mode }: { mode: "login" | "signup" | "admin" }) {
  const router = useRouter();
  const isSignup = mode === "signup";
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") || "").trim().toLowerCase();
    const password = String(data.get("password") || "");
    if (isSignup && password !== data.get("confirmPassword")) {
      setError("Your passwords don’t match. Please check them and try again.");
      return;
    }
    setBusy(true);
    try {
      const result = isSignup
        ? await authClient.signUp.email({ email, password, name: String(data.get("name") || "").trim() })
        : await authClient.signIn.email({ email, password, rememberMe: data.get("remember") === "on" });

      if (result.error) {
        if (result.error.status === 429) setError("A few too many attempts. Please wait a minute and try again.");
        else if (result.error.status >= 500) setError("We couldn’t connect to your account. Please try again in a moment.");
        else if (isSignup) setError(result.error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" || result.error.code === "USER_ALREADY_EXISTS" ? "An account with this email already exists. Try signing in." : "We couldn’t create your account. Check your details and try again.");
        else setError("The email or password isn’t right. Please try again.");
        return;
      }

      const accountResponse = await fetch("/api/account", { cache: "no-store" });
      if (!accountResponse.ok) throw new Error("No active session");
      const account = await accountResponse.json();
      if (mode === "admin" && account.user.role !== "admin") {
        await authClient.signOut();
        setError("This account doesn’t have administrator access. Please use member sign in.");
        return;
      }
      router.replace(mode === "admin" ? "/admin" : "/app");
      router.refresh();
    } catch {
      setError("Something interrupted the connection. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit} aria-busy={busy} aria-label={isSignup ? "Create your account" : mode === "admin" ? "Administrator sign in" : "Member sign in"}>
      {isSignup && <div className="field"><label htmlFor="name">Your name</label><input id="name" name="name" type="text" autoComplete="name" required maxLength={80} placeholder="Enter your name" disabled={busy} /></div>}
      <div className="field"><label htmlFor="email">Email address</label><input id="email" name="email" type="email" inputMode="email" autoComplete="email" required maxLength={254} placeholder="Enter your email" disabled={busy} /></div>
      <div className="field password-field"><label htmlFor="password">Password</label><input id="password" name="password" type={visible ? "text" : "password"} autoComplete={isSignup ? "new-password" : "current-password"} required minLength={isSignup ? 12 : 1} maxLength={128} placeholder={isSignup ? "Create a password" : "Enter your password"} aria-describedby={isSignup ? "password-help" : undefined} disabled={busy} /><button type="button" className="password-toggle" aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible} onClick={() => setVisible(!visible)} disabled={busy}>{visible ? "Hide" : "Show"}</button></div>
      {isSignup && <><p className="field-help" id="password-help">Use 12 or more characters.</p><div className="field"><label htmlFor="confirmPassword">Confirm password</label><input id="confirmPassword" name="confirmPassword" type={visible ? "text" : "password"} autoComplete="new-password" required minLength={12} maxLength={128} placeholder="Enter your password again" disabled={busy} /></div></>}
      {!isSignup && <label className="remember"><input type="checkbox" name="remember" value="on" defaultChecked disabled={busy} /> Keep me signed in</label>}
      {error && <div className="form-error" role="alert"><p>{error}</p></div>}
      <div className="auth-submit"><button className="primary-button" type="submit" disabled={busy}>{busy ? isSignup ? "Creating your account…" : "Signing in…" : isSignup ? "Create account" : "Sign in"}</button></div>
      <div className="form-switch">{isSignup ? <><Link href="/login">Already have an account? Log in</Link></> : mode === "admin" ? <Link href="/login">Member sign in</Link> : <Link href="/signup">Create an account</Link>}</div>
    </form>
  );
}
