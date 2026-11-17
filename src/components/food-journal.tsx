"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AppIcon } from "./app-header";
import { meals, localDateTime, nextFoodDate, macroCalorieEstimate, type FoodEstimate, type FoodEntry, type FoodInput, type FoodJournalData } from "@/lib/food";

const numberFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const format = (value: number) => numberFormat.format(value);
const mealLabels = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };
const timeFormat = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });

const nutritionFields = [
  { key: "calories", label: "Calories", unit: "kcal", max: 100000 },
  { key: "fat", label: "Fat", unit: "g", max: 10000 },
  { key: "protein", label: "Protein", unit: "g", max: 10000 },
  { key: "carbs", label: "Carbs", unit: "g", max: 10000 },
] as const;

export function FoodForm({ entry, draft, date, onClose, onSaved, saveFood, draftLabel = "Food estimate", saveLabel }: {
  entry: FoodEntry | null; draft?: (FoodEstimate & Partial<FoodInput>) | null; date: string; onClose: () => void; onSaved: (date: string, edited: boolean) => void;
  saveFood?: (food: FoodInput) => Promise<void>; draftLabel?: string; saveLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const initial = entry ?? draft;
  const [category, setCategory] = useState(initial?.category ?? "healthy");
  const [nutrition, setNutrition] = useState({
    calories: initial ? String(initial.calories) : "", fat: initial ? String(initial.fat) : "",
    protein: initial ? String(initial.protein) : "", carbs: initial ? String(initial.carbs) : "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const now = localDateTime();
  const defaultDateTime = date === now.slice(0, 10) ? now : date + "T12:00";
  const canSave = nutritionFields.every(({ key, max }) => {
    const value = Number(nutrition[key]);
    return nutrition[key].trim() !== "" && Number.isFinite(value) && value >= 0 && value <= max && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001;
  });

  const macroEstimate = canSave ? macroCalorieEstimate({
    calories: Number(nutrition.calories), fat: Number(nutrition.fat), protein: Number(nutrition.protein), carbs: Number(nutrition.carbs),
  }) : null;

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canSave) return;
    const data = new FormData(event.currentTarget);
    const payload: FoodInput & { id?: string; analysisId?: string | null } = {
      name: String(data.get("name") || "").trim(),
      calories: Number(nutrition.calories), protein: Number(nutrition.protein),
      carbs: Number(nutrition.carbs), fat: Number(nutrition.fat),
      meal: (data.get("meal") || null) as FoodInput["meal"], category,
      eatenAtLocal: String(data.get("eatenAtLocal") || initial?.eatenAtLocal || defaultDateTime),
      timeZone: initial?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(entry ? { id: entry.id, analysisId: entry.analysisId } : draft ? { analysisId: draft.analysisId } : {}),
    };
    setBusy(true); setError("");
    try {
      if (saveFood) { await saveFood(payload); onSaved(payload.eatenAtLocal.slice(0, 10), !!entry); return; }
      const result = await fetch("/api/food", {
        method: entry ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await result.json();
      if (!result.ok) { setError(body.message || "We couldn’t save this entry. Please try again."); return; }
      onSaved(payload.eatenAtLocal.slice(0, 10), !!entry);
    } catch (error) {
      setError(saveFood && error instanceof Error ? error.message : "We couldn’t confirm that this entry was saved. Close this form and refresh the journal before trying again.");
    } finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="food-dialog" aria-labelledby="food-form-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="food-form-heading"><h2 id="food-form-title">{entry ? "Edit food" : "Log food"}</h2><button className="dialog-close" type="button" aria-label="Close food form" disabled={busy} onClick={onClose}>×</button></div>
    <form aria-label={entry ? "Edit food" : "Log food"} onSubmit={submit}>
      <div className="food-form-body">
        {draft && <p className="photo-estimate-note">{draftLabel} · Review the nutrition before saving.</p>}
        <fieldset disabled={busy} className="food-facts"><legend><span>Nutrition facts</span><small>Required</small></legend><div className="food-input-group">
          {nutritionFields.map(item => <div className="nutrition-row" key={item.key}>
            <label htmlFor={"food-" + item.key}>{item.label}</label>
            <input id={"food-" + item.key} name={item.key} aria-label={item.label + " (" + item.unit + ")"} type="number" inputMode="decimal" min="0" max={item.max} step="0.01" required autoFocus={item.key === "calories"} value={nutrition[item.key]} onChange={event => setNutrition(current => ({ ...current, [item.key]: event.target.value }))} placeholder="—" />
            <span className="nutrition-unit" aria-hidden="true">{item.unit}</span>
          </div>)}
        </div></fieldset>
        {macroEstimate !== null && <p className="macro-warning" role="status">These macros suggest about {macroEstimate} kcal; you entered {nutrition.calories}. Check the values, or save as entered.</p>}
        <fieldset disabled={busy} className="food-details"><legend><span>Details</span><small>Optional</small></legend><div className="food-input-group">
          <div className="food-detail-row"><label htmlFor="food-name">Food name</label><input id="food-name" name="name" autoComplete="off" maxLength={120} defaultValue={initial?.name ?? ""} placeholder="Optional" /></div>
          <div className="food-detail-row"><label htmlFor="food-meal">Meal</label><select id="food-meal" name="meal" defaultValue={initial?.meal ?? ""}><option value="">Not set</option>{meals.map(meal => <option key={meal} value={meal}>{mealLabels[meal]}</option>)}</select></div>
          <div className="food-detail-row"><label htmlFor="food-time">When</label><input id="food-time" aria-label="Date and time" name="eatenAtLocal" type="datetime-local" min="2000-01-01T00:00" max="2100-12-31T23:59" defaultValue={initial?.eatenAtLocal ?? defaultDateTime} /></div>
          <div className="food-detail-row category-row"><span id="food-category-label">Category</span><div className="category-options" role="group" aria-labelledby="food-category-label">{(["healthy", "unhealthy"] as const).map(value => <label key={value} className={category === value ? "category-option selected" : "category-option"}><input type="radio" name="category" value={value} checked={category === value} onChange={() => setCategory(value)} /><span>{value === "healthy" ? "Healthy" : "Unhealthy"}</span></label>)}</div></div>
        </div></fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="food-form-actions"><button className="cancel-food-button" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" type="submit" disabled={busy || !canSave}>{busy ? "Saving…" : saveLabel ?? (entry ? "Save changes" : "Save food")}</button></div>
    </form>
  </dialog>;
}

export function FoodJournal({ active = true }: { active?: boolean }) {
  const journalCache = useRef(new Map<string, { value: FoodJournalData; at: number }>());
  const inFlight = useRef(new Set<string>());
  const [date, setDate] = useState("");
  const [data, setData] = useState<FoodJournalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [period, setPeriod] = useState<"day" | "month">("day");
  const [form, setForm] = useState<FoodEntry | "new" | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => { setDate(localDateTime().slice(0, 10)); }, []);
  useEffect(() => {
    if (!date) return;
    const cached = journalCache.current.get(date);
    setError(""); setConfirmDelete(null);
    setData(cached?.value ?? null);
    setLoading(!cached);
    if (cached && Date.now() - cached.at < 30_000) return;
    const controller = new AbortController();
    inFlight.current.add(date);
    fetch("/api/food?date=" + date, { cache: "no-store", signal: controller.signal })
      .then(async result => {
        const body = await result.json();
        if (!result.ok) {
          if (result.status === 401) { journalCache.current.clear(); setData(null); }
          throw new Error(body.message || "We couldn’t load your journal.");
        }
        return body as FoodJournalData;
      })
      .then(value => {
        if (controller.signal.aborted) return;
        journalCache.current.delete(date);
        journalCache.current.set(date, { value, at: Date.now() });
        if (journalCache.current.size > 32) journalCache.current.delete(journalCache.current.keys().next().value!);
        setData(value);
      })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "We couldn’t load your journal."); })
      .finally(() => {
        if (!controller.signal.aborted) { inFlight.current.delete(date); setLoading(false); }
      });
    return () => { controller.abort(); inFlight.current.delete(date); };
  }, [date, revision]);

  useEffect(() => {
    if (!active || !date) return;
    function refreshIfStale() {
      const cached = journalCache.current.get(date);
      if (document.visibilityState === "visible" && cached && Date.now() - cached.at >= 30_000 && !inFlight.current.has(date)) {
        setRevision(value => value + 1);
      }
    }
    refreshIfStale();
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [active, date]);

  useEffect(() => { if (!active) { setForm(null); setConfirmDelete(null); } }, [active]);

  function changeDate(value: string) {
    if (!value) return;
    const cached = journalCache.current.get(value);
    setData(cached?.value ?? null); setLoading(!cached);
    setDate(value); setNotice("");
  }

  function invalidateJournal() {
    for (const cached of journalCache.current.values()) cached.at = 0;
  }

  function refreshJournal() { invalidateJournal(); setRevision(value => value + 1); }

  useEffect(() => {
    function changed(event: Event) {
      invalidateJournal();
      const savedDate = (event as CustomEvent<string>).detail;
      if (savedDate) setDate(savedDate);
      setRevision(value => value + 1);
    }
    window.addEventListener("food-chat-saved", changed);
    return () => window.removeEventListener("food-chat-saved", changed);
  }, []);

  async function deleteEntry(id: string) {
    if (deleting) return;
    setDeleting(true); setError(""); setNotice("");
    try {
      const result = await fetch("/api/food", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      const body = await result.json();
      if (!result.ok) { setError(body.message || "We couldn’t delete this entry."); return; }
      setConfirmDelete(null); setNotice("Food entry deleted."); refreshJournal();
    } catch { setError("We couldn’t confirm the deletion. Refresh your journal before trying again."); }
    finally { setDeleting(false); }
  }

  const summary = data?.[period];
  const share = summary && summary.calories > 0 ? Math.round(summary.unhealthyCalories / summary.calories * 1000) / 10 : null;
  const periodLabel = date ? new Intl.DateTimeFormat("en", period === "month" ? { month: "long", year: "numeric" } : { day: "numeric", month: "short", year: "numeric" }).format(new Date(date + "T12:00")) : "";

  return <div className="food-journal">
    <div className="food-page-heading"><div><p className="eyebrow">A place for every bite</p><h1>Your food journal</h1><p className="page-subtitle">Every meal, snack, and small beginning.</p></div><div className="food-log-actions"><button className="primary-button log-food-button" onClick={() => setForm("new")} disabled={!date}><span aria-hidden="true">+</span> Log food</button></div></div>
    <div className="journal-controls">
      <div className="journal-date"><button className="date-arrow" aria-label="Previous day" disabled={!date || date === "2000-01-01" || deleting} onClick={() => changeDate(nextFoodDate(date, -1))}>‹</button><label><span className="sr-only">Journal date</span><input type="date" aria-label="Journal date" value={date} min="2000-01-01" max="2100-12-31" disabled={deleting} onChange={event => changeDate(event.target.value)} /></label><button className="date-arrow" aria-label="Next day" disabled={!date || date === "2100-12-31" || deleting} onClick={() => changeDate(nextFoodDate(date))}>›</button></div>
      <button className="text-button" disabled={deleting} onClick={() => changeDate(localDateTime().slice(0, 10))}>Today</button>
      <div className="summary-period" role="group" aria-label="Summary period"><button aria-pressed={period === "day"} onClick={() => setPeriod("day")}>Day</button><button aria-pressed={period === "month"} onClick={() => setPeriod("month")}>Month</button></div>
    </div>
    {notice && <p className="journal-notice" role="status">{notice}</p>}
    {error && <div className="form-error" role="alert"><p>{error}</p><button className="text-button" onClick={refreshJournal}>Refresh journal</button></div>}
    {loading && <p className="journal-loading" role="status">Loading your journal…</p>}
    {data && summary && <>
      <section className="food-summary" aria-label={period === "day" ? "Daily nutrition summary" : "Monthly nutrition summary"}>
        <div className="nutrition-total"><p className="summary-caption">{period === "day" ? "Your day" : "Your month"} · {periodLabel}</p><div className="calorie-total"><strong>{format(summary.calories)}</strong><span>kcal logged</span></div><dl className="macro-totals">{(["protein", "carbs", "fat"] as const).map(key => <div key={key}><dt>{key === "protein" ? "Protein" : key === "carbs" ? "Carbs" : "Fat"}</dt><dd>{format(summary[key])}<span> g</span></dd></div>)}</dl></div>
        <div className="food-choice-summary"><p className="summary-caption">Unhealthy food · {period === "day" ? "this day" : "this month"}</p><p className="choice-count"><strong>{summary.unhealthyEntries}</strong> of {summary.entries} entries</p><p><strong>{format(summary.unhealthyCalories)} kcal</strong> logged as Unhealthy</p><div className="choice-share">{share !== null ? <><strong>{format(share)}%</strong><span>of your logged calories</span></> : <span>No calorie total yet</span>}</div></div>
      </section>
      <section className="meal-journal" aria-labelledby="meal-journal-title"><div className="section-heading"><h2 id="meal-journal-title">Meals for {new Intl.DateTimeFormat("en", { day: "numeric", month: "short" }).format(new Date(date + "T12:00"))}</h2><p>{data.day.entries} {data.day.entries === 1 ? "entry" : "entries"} logged</p></div>
        {data.entries.length === 0 ? <div className="food-empty"><AppIcon name="food" /><h3>A little space for what you ate.</h3><p>Breakfast, a quick snack, or dinner with friends.<br />Start with your first food entry.</p><button className="primary-button" onClick={() => setForm("new")}>Log your first food</button></div>
          : <div className="meal-groups">{[...meals, null].map(meal => {
            const groupLabel = meal === null ? "Other" : mealLabels[meal];
            const entries = data.entries.filter(entry => entry.meal === meal);
            return entries.length > 0 && <section className="meal-group" key={meal ?? "other"} aria-label={groupLabel}><h3>{groupLabel}</h3><div className="food-entry-list">{entries.map(entry => <article className="food-entry" key={entry.id} aria-label={entry.name || "Food entry"}>
              <div className="food-entry-top"><div><h4>{entry.name || "Food entry"}</h4><p className="entry-meta"><time dateTime={entry.eatenAtLocal}>{timeFormat.format(new Date(entry.eatenAtLocal))}</time><span aria-hidden="true">·</span><span>{entry.category === "healthy" ? "Healthy" : "Unhealthy"}</span>{entry.analysisId && <><span aria-hidden="true">·</span><span>AI estimate</span></>}</p></div><div className="entry-calories"><strong>{format(entry.calories)}</strong><span> kcal</span></div></div>
              <div className="food-entry-bottom"><p>Protein {format(entry.protein)} g <span>·</span> Carbs {format(entry.carbs)} g <span>·</span> Fat {format(entry.fat)} g</p><div className="entry-actions"><button className="text-button" disabled={deleting} onClick={() => setForm(entry)}>Edit</button><button className="text-button" disabled={deleting} onClick={() => setConfirmDelete(entry.id)}>Delete</button></div></div>
              {confirmDelete === entry.id && <div className="delete-confirmation" role="group" aria-label={"Delete " + (entry.name || "Food entry")}><p>Delete this food entry?</p><div><button className="text-button" disabled={deleting} onClick={() => setConfirmDelete(null)}>Keep entry</button><button className="text-button delete-button" disabled={deleting} onClick={() => deleteEntry(entry.id)}>{deleting ? "Deleting…" : "Delete entry"}</button></div></div>}
            </article>)}</div></section>;
          })}</div>}
        {data.day.entries > data.entries.length && <p className="account-note">Showing the latest {data.entries.length} entries. Your totals include all {data.day.entries} entries.</p>}
      </section>
    </>}
    {form && <FoodForm entry={form === "new" ? null : form} date={date} onClose={() => setForm(null)} onSaved={(savedDate, edited) => { invalidateJournal(); setForm(null); setDate(savedDate); setNotice(edited ? "Food entry updated." : "Food logged."); setRevision(value => value + 1); }} />}
  </div>;
}
