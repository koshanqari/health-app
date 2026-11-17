"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { localDateTime } from "@/lib/food";
import type { UserProfile } from "@/lib/profile";

export function Profile({ onClose, onSaved }: { onClose: () => void; onSaved: (user: UserProfile) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [draft, setDraft] = useState({ name: "", dateOfBirth: "", sex: "" });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [saved, setSaved] = useState(false), [retry, setRetry] = useState(0);
  const dirty = !!user && (draft.name.trim() !== user.name || draft.dateOfBirth !== (user.dateOfBirth ?? "") || draft.sex !== (user.sex ?? ""));

  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    fetch("/api/account", { cache: "no-store", signal: controller.signal })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.message || "We couldn’t load your profile."); return body.user as UserProfile; })
      .then(value => { if (!controller.signal.aborted) { setUser(value); setDraft({ name: value.name, dateOfBirth: value.dateOfBirth ?? "", sex: value.sex ?? "" }); } })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "We couldn’t load your profile."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!user || !dirty || busy || !draft.name.trim()) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      const response = await fetch("/api/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "We couldn’t save your profile.");
      const updated = body.user as UserProfile;
      setUser(updated); setDraft({ name: updated.name, dateOfBirth: updated.dateOfBirth ?? "", sex: updated.sex ?? "" });
      setSaved(true); onSaved(updated);
    } catch (error) { setError(error instanceof Error ? error.message : "We couldn’t save your profile. Please try again."); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="food-dialog profile-dialog" aria-labelledby="profile-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="profile-heading"><button type="button" className="text-button" aria-label="Back to app" disabled={busy} onClick={onClose}><span aria-hidden="true">←</span> Back</button><h1 id="profile-title">Profile</h1></div>
    {loading ? <p className="profile-loading" role="status">Loading your profile…</p> : !user ? <div className="form-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => setRetry(value => value + 1)}>Try again</button></div> : <form aria-label="Your profile" className="profile-form" onSubmit={submit}>
      <div className="food-form-body">
        <fieldset disabled={busy} className="food-facts"><div className="food-input-group">
          <div className="food-detail-row"><label htmlFor="profile-name">Name</label><input id="profile-name" autoComplete="name" required maxLength={80} value={draft.name} onChange={event => { setDraft(current => ({ ...current, name: event.target.value })); setSaved(false); }} /></div>
          <div className="food-detail-row"><label htmlFor="profile-email">Email</label><input id="profile-email" type="email" autoComplete="email" readOnly value={user.email} /></div>
          <div className="food-detail-row"><label htmlFor="profile-dob">Date of birth</label><input id="profile-dob" type="date" autoComplete="bday" min="1900-01-01" max={localDateTime().slice(0, 10)} value={draft.dateOfBirth} onChange={event => { setDraft(current => ({ ...current, dateOfBirth: event.target.value })); setSaved(false); }} /></div>
          <div className="food-detail-row"><label htmlFor="profile-sex">Sex</label><select id="profile-sex" value={draft.sex} onChange={event => { setDraft(current => ({ ...current, sex: event.target.value })); setSaved(false); }}><option value="">Not set</option><option value="female">Female</option><option value="male">Male</option><option value="intersex">Intersex</option><option value="prefer_not_to_say">Prefer not to say</option></select></div>
        </div></fieldset>
        <p className="profile-hint">Date of birth and sex are optional. Email is linked to your sign-in.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {saved && <p className="profile-saved" role="status">Profile saved.</p>}
      </div>
      <div className="profile-actions"><button type="submit" className="primary-button" disabled={busy || !dirty || !draft.name.trim()}>{busy ? "Saving…" : "Save changes"}</button></div>
    </form>}
  </dialog>;
}
