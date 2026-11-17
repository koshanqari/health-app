"use client";

import { useEffect, useRef, useState } from "react";

const release = process.env.NEXT_PUBLIC_APP_RELEASE || "local";
export type UpdateGuard = { busy: boolean; dirty: boolean };

export function AppUpdates() {
  const [available, setAvailable] = useState<string | null>(null);
  const dismissed = useRef<string | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let checking = false, lastChecked = 0, disposed = false;
    const controller = new AbortController();
    async function check() {
      if (checking || disposed || document.visibilityState !== "visible" || !navigator.onLine || Date.now() - lastChecked < 30_000) return;
      checking = true; lastChecked = Date.now();
      try {
        const response = await fetch("/api/version", { cache: "no-store", signal: controller.signal, headers: { "x-daywell-release": release } });
        if (!response.ok) return;
        const data = await response.json();
        if (!disposed && typeof data.release === "string" && data.release && data.release !== release && data.release !== dismissed.current) setAvailable(data.release);
      } catch { /* Offline or a deployment in progress: keep the current app and session. */ }
      finally { checking = false; }
    }
    const onResume = () => { void check(); };
    const initial = setTimeout(onResume, 1000), timer = setInterval(onResume, 60_000);
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("online", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      disposed = true; controller.abort(); clearTimeout(initial); clearInterval(timer);
      window.removeEventListener("focus", onResume); window.removeEventListener("pageshow", onResume); window.removeEventListener("online", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, []);
  function update() {
    setMessage("");
    const guard: UpdateGuard = { busy: false, dirty: false };
    window.dispatchEvent(new CustomEvent<UpdateGuard>("daywell-update-guard", { detail: guard }));
    const forms = Array.from(document.querySelectorAll<HTMLFormElement>("dialog[open] form"));
    guard.dirty ||= forms.length > 0;
    guard.busy ||= !!document.querySelector('form[aria-busy="true"], dialog[open] fieldset[disabled]');
    guard.busy ||= Array.from(document.querySelectorAll<HTMLButtonElement>("button:disabled")).some(button => /Saving|Deleting|Signing|Creating|Logging/.test(button.textContent || ""));
    if (guard.busy) { setMessage("Please wait for your current action to finish."); return; }
    if (guard.dirty && !window.confirm("Updating will clear unsent messages, selected photos and unsaved drafts. Update now?")) return;
    // A reload downloads the new release while preserving the sign-in cookie.
    window.location.reload();
  }
  if (!available) return null;
  return <aside className="app-update" role="status" aria-live="polite">
    <div><p>A new version is ready.</p>{message && <small>{message}</small>}</div>
    <div className="app-update-actions"><button type="button" className="text-button" onClick={() => { dismissed.current = available; setAvailable(null); setMessage(""); }}>Later</button><button type="button" className="primary-button" onClick={update}>Update app</button></div>
  </aside>;
}
