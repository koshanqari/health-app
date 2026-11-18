"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { UpdateGuard } from "./app-updates";
import type { CreditDefaults } from "@/lib/credits";

export function CreditDefaultsForm({ initial }: { initial: CreditDefaults }) {
  const [saved, setSaved] = useState(initial);
  const [welcome, setWelcome] = useState(String(initial.welcomeCredits)), [multiplier, setMultiplier] = useState(String(initial.multiplier));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    const guard = (event: Event) => {
      const detail = (event as CustomEvent<UpdateGuard>).detail;
      detail.busy ||= busy;
      detail.dirty ||= Number(welcome) !== saved.welcomeCredits || Number(multiplier) !== saved.multiplier || !welcome || !multiplier;
    };
    window.addEventListener("daywell-update-guard", guard);
    return () => window.removeEventListener("daywell-update-guard", guard);
  }, [busy, welcome, multiplier, saved]);
  async function reload() {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/credit-defaults", { cache: "no-store" });
      const next = await response.json();
      if (!response.ok) throw new Error(next.message);
      setSaved(next); setWelcome(String(next.welcomeCredits)); setMultiplier(String(next.multiplier)); setConflict(false);
    } catch (error) { setError(error instanceof Error ? error.message : "We couldn’t reload the defaults."); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || conflict) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/credit-defaults", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ welcomeCredits: Number(welcome), multiplier: Number(multiplier), revision: saved.revision }) });
      const next = await response.json();
      if (!response.ok) { if (response.status === 409) setConflict(true); throw new Error(next.message); }
      setSaved(next); setMessage("Defaults saved. New signups will use these values.");
    } catch (error) { setError(error instanceof Error ? error.message : "We couldn’t save the defaults."); }
    finally { setBusy(false); }
  }
  return <section className="credit-defaults" aria-labelledby="credit-defaults-title">
    <h2 id="credit-defaults-title">New account defaults</h2>
    <p className="account-note">A one-time welcome grant for new signups. Existing balances and personal multipliers stay unchanged.</p>
    <form aria-label="New account defaults" onSubmit={submit} aria-busy={busy}>
      <fieldset disabled={busy} className="admin-create-fields">
        <div className="credit-default-fields">
          <div className="field"><label htmlFor="default-welcome-credits">Welcome credits</label><input id="default-welcome-credits" type="number" min="0" max="1000" step="0.01" required value={welcome} onChange={event => { setWelcome(event.target.value); setMessage(""); }} /></div>
          <div className="field"><label htmlFor="default-multiplier">Default multiplier</label><input id="default-multiplier" type="number" min="0.1" max="10" step="0.01" required value={multiplier} onChange={event => { setMultiplier(event.target.value); setMessage(""); }} /></div>
        </div>
        <button className="primary-button" type="submit" disabled={conflict}>{busy ? "Saving…" : "Save defaults"}</button>
        {conflict && <button className="text-button" type="button" onClick={() => void reload()}>Reload defaults</button>}
      </fieldset>
      {message && <p role="status" className="journal-notice">{message}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </form>
  </section>;
}
