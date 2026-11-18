"use client";

import { useState, type FormEvent } from "react";
import { useViewingAs } from "./member-view";
import { profileChangeFields, type ProfileChange, type ProfileChangeField } from "@/lib/profile";
import type { FoodChatProfileDraft } from "@/lib/food";

const labels = { age: "Age (years)", sex: "Sex", heightCm: "Height (cm)", weightKg: "Weight (kg)" };
export function ProfileProposal({ draft, active, saved, busy, onSave }: {
  draft: FoodChatProfileDraft; active: boolean; saved: boolean; busy: boolean;
  onSave: (id: string, changes: ProfileChange) => Promise<void>;
}) {
  const viewingAs = useViewingAs();
  const fields = profileChangeFields.filter(key => key in draft.changes);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(key => [key, draft.changes[key] == null ? "" : String(draft.changes[key])])));
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!active || saved || busy || saving || viewingAs) return;
    setSaving(true); setError("");
    try {
      const changes = Object.fromEntries(fields.map(key => [key, values[key] === "" ? null : key === "sex" ? values[key] : Number(values[key])])) as ProfileChange;
      await onSave(draft.draftId, changes);
    } catch (error) { setError(error instanceof Error ? error.message : "We couldn’t save your profile."); }
    finally { setSaving(false); }
  }
  function edit(key: ProfileChangeField, value: string) { setValues(current => ({ ...current, [key]: value })); setError(""); }
  return <div className="chat-food-draft chat-profile-draft" aria-label={saved ? "Saved profile update" : "Profile proposal"}>
    <div className="chat-draft-heading"><h3>Profile update</h3><span>{saved ? "Saved" : "Proposal"}</span></div>
    <form aria-label="Profile update" onSubmit={submit} aria-busy={saving}>
      <fieldset disabled={!active || saved || busy || saving || !!viewingAs} className="admin-create-fields">
        <div className="food-input-group">
          {fields.map(key => <div className="food-detail-row" key={key}>
            <label htmlFor={`proposal-${draft.draftId}-${key}`}>{labels[key]}</label>
            {key === "sex" ? <select id={`proposal-${draft.draftId}-${key}`} value={values[key]} onChange={event => edit(key, event.target.value)}>
              <option value="">Not set</option><option value="female">Female</option><option value="male">Male</option><option value="intersex">Intersex</option><option value="prefer_not_to_say">Prefer not to say</option>
            </select> : <input id={`proposal-${draft.draftId}-${key}`} type="number" inputMode={key === "age" ? "numeric" : "decimal"} min={key === "age" ? 0 : .1} max={key === "age" ? 130 : key === "heightCm" ? 300 : 500} step={key === "age" ? 1 : .1} placeholder="Not set" value={values[key]} onChange={event => edit(key, event.target.value)} />}
          </div>)}
        </div>
        {draft.assumptions && <p className="chat-assumptions">{draft.assumptions}</p>}
        {active && !saved && <button className="primary-button" type="submit">{saving ? "Saving…" : "Save profile"}</button>}
      </fieldset>
      {saved ? <p className="chat-saved">Profile saved.</p> : !active && <p className="chat-old-draft">Earlier proposal · See the latest reply.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </div>;
}
