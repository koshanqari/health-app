"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export type ViewingAs = { token: string; name: string; expiresAt: string };
const ViewContext = createContext<ViewingAs | null>(null);
export function MemberViewProvider({ value, children }: { value: ViewingAs | null; children: ReactNode }) {
  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}
export const useViewingAs = () => useContext(ViewContext);
export function useMemberFetch() {
  const view = useViewingAs();
  return useCallback((input: string, init?: RequestInit) => {
    if (!view) return window.fetch(input, init);
    const url = new URL(input, window.location.origin);
    if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) url.searchParams.set("view", view.token);
    return window.fetch(url.toString(), init);
  }, [view?.token]);
}
export function ViewingBanner() {
  const view = useViewingAs();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!view) return null;
  async function exit() {
    if (!view || busy) return;
    setBusy(true); setError("");
    try {
      const response = await window.fetch("/api/admin/views", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: view.token }) });
      if (!response.ok) throw new Error("Couldn’t end this view. Please try again.");
      window.location.assign("/admin");
    } catch (error) { setError(error instanceof Error ? error.message : "Please try again."); setBusy(false); }
  }
  return <aside className="viewing-banner" aria-label="Admin viewing session">
    <div><strong>Viewing as {view.name}</strong><span>Read-only · expires after 30 minutes</span>{error && <small role="alert">{error}</small>}</div>
    <button className="text-button" type="button" disabled={busy} onClick={() => void exit()}>{busy ? "Exiting…" : "Exit view"}</button>
  </aside>;
}

export function ViewAsUserButton({ userId, email }: { userId: string; email: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function start() {
    setBusy(true); setError("");
    try {
      const response = await window.fetch("/api/admin/views", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "We couldn’t open this account.");
      window.location.assign(body.url);
    } catch (error) { setError(error instanceof Error ? error.message : "Please try again."); setBusy(false); }
  }
  return <><button className="text-button" type="button" aria-label={`View as user: ${email}`} disabled={busy} onClick={() => void start()}>{busy ? "Opening…" : "View as user"}</button>{error && <small role="alert">{error}</small>}</>;
}
