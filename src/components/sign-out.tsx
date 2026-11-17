"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignOut({ disabled = false, redirectTo = "/login" }: { disabled?: boolean; redirectTo?: "/login" | "/admin" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="signout-wrap"><button type="button" className="text-button" disabled={busy || disabled} onClick={async () => {
    setBusy(true); setFailed(false);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Sign out failed");
      router.replace(redirectTo); router.refresh();
    } catch { setFailed(true); setBusy(false); }
  }}>{busy ? "Signing out…" : "Sign out"}</button>{failed && <small role="alert">Couldn’t sign out. Please try again.</small>}</div>;
}
