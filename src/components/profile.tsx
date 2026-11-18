"use client";

import { useMemberFetch, useViewingAs } from "./member-view";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { localDateTime } from "@/lib/food";
import { profileAvatars, type ProfileAvatarId, type UserProfile } from "@/lib/profile";
import { ProfileAvatar } from "./profile-avatar";
import { CreditWallet } from "./credit-wallet";
import { SignOut } from "./sign-out";

export function Profile({ onClose, onSaved, admin = false }: { onClose: () => void; onSaved: (user: UserProfile) => void; admin?: boolean }) {
  const fetch = useMemberFetch();
  const viewingAs = useViewingAs();
  const dialog = useRef<HTMLDialogElement>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [draft, setDraft] = useState<{ name: string; dateOfBirth: string; sex: string; heightCm: string; avatarId: ProfileAvatarId | null }>({ name: "", dateOfBirth: "", sex: "", heightCm: "", avatarId: null });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [saved, setSaved] = useState(false), [retry, setRetry] = useState(0);
  const dirty = !!user && (draft.name.trim() !== user.name || draft.dateOfBirth !== (user.dateOfBirth ?? "") || draft.sex !== (user.sex ?? "") || draft.avatarId !== (user.avatarId ?? null) || draft.heightCm !== (user.heightCm == null ? "" : String(user.heightCm)));

  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    fetch("/api/account", { cache: "no-store", signal: controller.signal })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.message || "We couldn’t load your profile."); return body.user as UserProfile; })
      .then(value => { if (!controller.signal.aborted) { setUser(value); setDraft({ name: value.name, dateOfBirth: value.dateOfBirth ?? "", sex: value.sex ?? "", heightCm: value.heightCm == null ? "" : String(value.heightCm), avatarId: value.avatarId ?? null }); } })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "We couldn’t load your profile."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!user || !dirty || busy || !draft.name.trim()) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      const response = await fetch("/api/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, heightCm: draft.heightCm.trim() ? Number(draft.heightCm) : null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "We couldn’t save your profile.");
      const updated = body.user as UserProfile;
      setUser(updated); setDraft({ name: updated.name, dateOfBirth: updated.dateOfBirth ?? "", sex: updated.sex ?? "", heightCm: updated.heightCm == null ? "" : String(updated.heightCm), avatarId: updated.avatarId ?? null });
      setSaved(true); onSaved(updated);
    } catch (error) { setError(error instanceof Error ? error.message : "We couldn’t save your profile. Please try again."); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="food-dialog profile-dialog" aria-labelledby="profile-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="profile-heading"><button type="button" className="text-button" aria-label={admin ? "Back to admin" : "Back to app"} disabled={busy} onClick={onClose}>Back</button><h1 id="profile-title">Profile</h1></div>
    {loading ? <p className="profile-loading" role="status">Loading your profile…</p> : !user ? <div className="form-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => setRetry(value => value + 1)}>Try again</button></div> : <form aria-label="Your profile" className="profile-form" onSubmit={submit}>
      <div className="food-form-body">
        <fieldset className="profile-picture-picker food-facts" disabled={busy || !!viewingAs}>
          <legend>Profile picture</legend>
          <div className="profile-avatar-preview" role="img" aria-label={draft.avatarId ? `${profileAvatars.find(avatar => avatar.id === draft.avatarId)?.label} avatar preview` : "Initials avatar preview"}><ProfileAvatar avatarId={draft.avatarId} name={draft.name} /></div>
          <div className="profile-avatar-options">{profileAvatars.map(avatar => <label key={avatar.id} className={draft.avatarId === avatar.id ? "profile-avatar-option selected" : "profile-avatar-option"}>
            <input type="radio" name="profile-avatar" value={avatar.id} checked={draft.avatarId === avatar.id} onChange={() => { setDraft(current => ({ ...current, avatarId: avatar.id })); setSaved(false); }} />
            <ProfileAvatar avatarId={avatar.id} name={draft.name} /><span>{avatar.label}</span>
          </label>)}</div>
          <button type="button" className="text-button profile-use-initials" disabled={!!viewingAs || !draft.avatarId || busy} onClick={() => { setDraft(current => ({ ...current, avatarId: null })); setSaved(false); }}>Use initials</button>
        </fieldset>
        <fieldset disabled={busy || !!viewingAs} className="food-facts"><div className="food-input-group">
          <div className="food-detail-row"><label htmlFor="profile-name">Name</label><input id="profile-name" autoComplete="name" required maxLength={80} value={draft.name} onChange={event => { setDraft(current => ({ ...current, name: event.target.value })); setSaved(false); }} /></div>
          <div className="food-detail-row"><label htmlFor="profile-email">Email</label><input id="profile-email" type="email" autoComplete="email" readOnly value={user.email} /></div>
          <div className="food-detail-row"><label htmlFor="profile-dob">Date of birth</label><input id="profile-dob" type="date" autoComplete="bday" min="1900-01-01" max={localDateTime().slice(0, 10)} value={draft.dateOfBirth} onChange={event => { setDraft(current => ({ ...current, dateOfBirth: event.target.value })); setSaved(false); }} /></div>
          <div className="food-detail-row"><label htmlFor="profile-sex">Sex</label><select id="profile-sex" value={draft.sex} onChange={event => { setDraft(current => ({ ...current, sex: event.target.value })); setSaved(false); }}><option value="">Not set</option><option value="female">Female</option><option value="male">Male</option><option value="intersex">Intersex</option><option value="prefer_not_to_say">Prefer not to say</option></select></div>
          <div className="food-detail-row"><label htmlFor="profile-height">Height (cm)</label><input id="profile-height" type="number" inputMode="decimal" min="0.1" max="300" step="0.1" placeholder="Not set" value={draft.heightCm} onChange={event => { setDraft(current => ({ ...current, heightCm: event.target.value })); setSaved(false); }} /></div>
        </div></fieldset>
        <p className="profile-hint">Date of birth, sex and height are optional. Email is linked to your sign-in.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {saved && <p className="profile-saved" role="status">Profile saved.</p>}
      </div>
      <div className="profile-actions"><button type="submit" className="primary-button" disabled={!!viewingAs || busy || !dirty || !draft.name.trim()}>{busy ? "Saving…" : "Save changes"}</button></div>
    </form>}
    <div className="profile-credit-link"><CreditWallet label="View AI credits" /></div>
    {!viewingAs && <div className="profile-signout"><SignOut disabled={busy || !!viewingAs} redirectTo={admin ? "/admin" : "/login"} /></div>}
  </dialog>;
}
