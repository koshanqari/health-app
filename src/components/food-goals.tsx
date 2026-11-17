"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { macroCalorieEstimate, type FoodSummary } from "@/lib/food";
import { foodGoalProgress, goalMacroValues, goalNutrients, parseFoodGoals, suggestedFoodGoals, suggestedMacros, type FoodGoals, type GoalNutrient } from "@/lib/food-goals";

const format = (value: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
const labels = { calories: "Calories", protein: "Protein", carbs: "Carbs", fat: "Fat" };
const bounds = ["min", "max"] as const;
type Draft = Record<GoalNutrient, { min: string; max: string }>;
const toDraft = (goals: FoodGoals) => Object.fromEntries(goalNutrients.map(key => [key, { min: String(goals[key].min), max: String(goals[key].max) }])) as Draft;

function GoalForm({ goals, onClose, onSaved }: { goals: FoodGoals | null; onClose: () => void; onSaved: (value: FoodGoals) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => toDraft(goals ?? suggestedFoodGoals()));
  const [custom, setCustom] = useState(() => {
    const initial = goals ?? suggestedFoodGoals();
    const suggested = suggestedFoodGoals(initial.calories.min, initial.calories.max);
    return new Set(goalNutrients.flatMap(key => bounds.filter(bound => key !== "calories" && initial[key][bound] !== suggested[key][bound]).map(bound => `${key}.${bound}`)));
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  let parsed: FoodGoals | null = null, validation = "";
  try {
    if (goalNutrients.some(key => bounds.some(bound => !draft[key][bound].trim()))) throw new Error("Fill in both ends of every range.");
    parsed = parseFoodGoals(Object.fromEntries(goalNutrients.map(key => [key, { min: Number(draft[key].min), max: Number(draft[key].max) }])));
  } catch (error) { validation = (error as Error).message; }

  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);

  function change(key: GoalNutrient, bound: "min" | "max", value: string) {
    if (key !== "calories") setCustom(current => new Set([...current, `${key}.${bound}`]));
    setDraft(current => {
      const next = { ...current, [key]: { ...current[key], [bound]: value } };
      if (key === "calories" && value.trim() && Number(value) > 0 && Number(value) <= 100000) {
        const suggested = suggestedMacros(Number(value));
        for (const macro of ["protein", "carbs", "fat"] as const) if (!custom.has(`${macro}.${bound}`)) next[macro] = { ...current[macro], [bound]: String(suggested[macro]) };
      }
      return next;
    });
  }

  function resetMacros() {
    const suggested = suggestedFoodGoals(Number(draft.calories.min), Number(draft.calories.max));
    setDraft(current => ({ ...toDraft(suggested), calories: current.calories }));
    setCustom(new Set());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!parsed || busy) return;
    setBusy(true); setError("");
    try {
      const result = await fetch("/api/food/goals", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed) });
      const body = await result.json();
      if (!result.ok) throw new Error(body.message || "We couldn’t save your goals.");
      onSaved(body.goals);
    } catch (error) { setError(error instanceof Error ? error.message : "We couldn’t confirm your goals were saved. Please try again."); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="food-dialog goal-dialog" aria-labelledby="goal-form-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="food-form-heading"><h2 id="goal-form-title">Daily food goals</h2><button type="button" className="dialog-close" aria-label="Close goals" disabled={busy} onClick={onClose}>×</button></div>
    <form onSubmit={submit} aria-label="Daily food goals">
      <div className="food-form-body">
        <p className="goal-form-intro">A little flexibility for every day. Set a range that works for you.</p>
        <fieldset disabled={busy} className="food-facts">
          <div className="goal-input-head" aria-hidden="true"><span /><span>Minimum</span><span>Maximum</span></div>
          <div className="food-input-group">{goalNutrients.map(key => <div className="goal-input-row" key={key}>
            <span>{labels[key]}<small>{key === "calories" ? "kcal" : "g"}</small></span>
            {bounds.map(bound => <input key={bound} aria-label={`${bound === "min" ? "Minimum" : "Maximum"} ${labels[key].toLowerCase()} (${key === "calories" ? "kcal" : "g"})`} type="number" inputMode="decimal" min={key === "calories" && bound === "min" ? ".01" : "0"} max={key === "calories" ? 100000 : 10000} step="0.01" required value={draft[key][bound]} onChange={event => change(key, bound, event.target.value)} autoFocus={key === "calories" && bound === "min"} />)}
          </div>)}</div>
        </fieldset>
        <p className="goal-form-hint">Macros start at 25% protein, 50% carbs and 25% fat. Calorie changes update values you haven’t edited.</p>
        <button type="button" className="text-button goal-reset" disabled={busy || !draft.calories.min.trim() || !draft.calories.max.trim() || !Number.isFinite(Number(draft.calories.min)) || !Number.isFinite(Number(draft.calories.max))} onClick={resetMacros}>Use suggested macros</button>
        {validation && <p className="macro-warning" role="status">{validation}</p>}
        {parsed && bounds.map(bound => {
          const estimate = macroCalorieEstimate(goalMacroValues(parsed!, bound));
          return estimate !== null && <p className="macro-warning" role="status" key={bound}>{bound === "min" ? "Minimum" : "Maximum"} macros suggest about {format(estimate)} kcal; your calorie goal is {format(parsed!.calories[bound])}. Check the values, or save as entered.</p>;
        })}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="food-form-actions"><button type="button" className="cancel-food-button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !parsed}>{busy ? "Saving…" : "Save goals"}</button></div>
    </form>
  </dialog>;
}

function NutrientProgress({ nutrient, consumed, goals }: { nutrient: GoalNutrient; consumed: number; goals: FoodGoals }) {
  const range = goals[nutrient], progress = foodGoalProgress(consumed, range);
  const unit = nutrient === "calories" ? "kcal" : "g";
  const value = progress.status === "below" ? format(progress.remainingMin) : progress.status === "over" ? format(progress.over) : "In range";
  const caption = progress.status === "below" ? `${unit} to minimum` : progress.status === "over" ? `${unit} over maximum` : `${format(progress.remainingMax)} ${unit} to maximum`;
  return <div className={`goal-nutrient goal-${nutrient}`}>
    <h3>{labels[nutrient]}</h3><p className="goal-remaining"><strong>{value}</strong><span>{caption}</span></p>
    <div className="goal-meter" role="progressbar" aria-label={`${labels[nutrient]} goal`} aria-valuemin={0} aria-valuemax={range.max || 1} aria-valuenow={Math.min(consumed, range.max || 1)} aria-valuetext={`${format(consumed)} ${unit} logged; goal ${format(range.min)} to ${format(range.max)} ${unit}; ${value} ${caption}`}>
      <span className="goal-meter-fill" style={{ width: `${progress.percent}%` }} />
      {range.max > 0 && <span className="goal-meter-min" style={{ left: `${Math.min(99, range.min / range.max * 100)}%` }} />}
    </div>
    <p className="goal-range">{format(consumed)} logged <span>·</span> {format(range.min)}–{format(range.max)} {unit} goal</p>
    {nutrient === "calories" && progress.status === "below" && <p className="goal-room">Up to {format(progress.remainingMax)} kcal left in your range</p>}
  </div>;
}

export function FoodGoalPanel({ goals, day, date, onSaved }: { goals: FoodGoals | null; day: FoodSummary; date: string; onSaved: (value: FoodGoals) => void }) {
  const [editing, setEditing] = useState(false);
  const today = new Date(), selected = new Date(date + "T12:00");
  const isToday = today.toDateString() === selected.toDateString();
  return <>
    <section className="food-goals" aria-label="Daily food goals">
      <div className="goal-panel-heading"><h2>{isToday ? "Today’s goals" : `Goals for ${new Intl.DateTimeFormat("en", { day: "numeric", month: "short" }).format(selected)}`}</h2><button className="text-button" onClick={() => setEditing(true)}>{goals ? "Edit goals" : "Set goals"}</button></div>
      {goals ? <div className="goal-progress-grid">{goalNutrients.map(nutrient => <NutrientProgress key={nutrient} nutrient={nutrient} consumed={day[nutrient]} goals={goals} />)}</div> : <div className="goal-unset"><p>Give your day a little direction.</p><p>Set calorie and macro ranges to see what’s left as you log.</p></div>}
    </section>
    {editing && <GoalForm goals={goals} onClose={() => setEditing(false)} onSaved={value => { onSaved(value); setEditing(false); }} />}
  </>;
}
