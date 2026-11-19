"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { GoalForm, FoodGoalPanel } from "./food-goals";
import { ActivityGoalForm, ActivitySummaryCard } from "./activity-journal";
import { useMemberFetch, useViewingAs } from "./member-view";
import { localDateTime, type FoodSummary } from "@/lib/food";
import { type FoodGoals, type GoalNutrient } from "@/lib/food-goals";
import type { ActivityDay, ActivityGoals } from "@/lib/activity";
import type { ProfileDetails } from "@/lib/profile";
import { defaultHomePreferences, type HomePreferences, type HomeCard } from "@/lib/home-preferences";
type HomeProfile = Pick<ProfileDetails, "age" | "sex" | "heightCm" | "weightKg">;
type HomeData = { date: string; activity: ActivityDay; activityGoals: ActivityGoals | null; food: Pick<FoodSummary, "entries" | "calories" | "protein" | "carbs" | "fat">; foodGoals: FoodGoals | null; foodGoalEffectiveFrom: string | null; preferences: HomePreferences; profile: HomeProfile };
// Original daily notes: no provider call, attribution or user credits required.
const dailyNotes = [
  "A little care today is a gift to tomorrow’s you.", "You don’t have to do it all. Start with a little.", "There is room for a fresh start in every day.",
  "Let today be kind to you, and you to yourself.", "Small steps count, even on the quiet days.", "A good day can begin with one caring choice.",
  "Give yourself the patience you give the people you love.", "Make a little room for what makes you feel good.", "Progress can be gentle. Keep going at your pace.",
  "A meal, a walk, a moment for yourself. It all counts.", "Today is a lovely day to begin again.", "Care grows in the little things you do each day.",
  "You are allowed to take your time and still move forward.", "Find one small thing your future self will thank you for.", "Your effort matters, even when no one sees it.",
  "A softer start is still a start.", "Leave a little space in your day for you.", "You can be a work in progress and still be worth caring for.",
  "Some days are for growing. Some days are for resting.", "Keep the promises to yourself small and kind.", "There is something hopeful about showing up again.",
  "Your pace belongs to you.", "One thoughtful choice can change the feel of a day.", "Let a little kindness lead the way today.",
  "Take care of the person who carries you through every day.", "You don’t need a perfect day to do something good for yourself.", "A small beginning can hold a lot of hope.",
  "There is no hurry to become someone worth loving. You already are.", "Make today a little lighter, one choice at a time.", "Let feeling good be part of the plan.", "You can start where you are, with what you have.",
];
function SmallSteps() {
  return <svg className="home-apple" viewBox="0 0 180 180" fill="none" aria-hidden="true">
    <path d="M25 161c43-8 89-8 135 0" stroke="#A8DAB5" strokeWidth="2" strokeLinecap="round" />
    <path d="M43 91c-4-36 20-60 54-58 36 1 55 24 52 59-3 40-23 66-58 65-34-1-46-27-48-66Z" fill="#81C995" />
    <path d="M74 87c2-4 6-4 8 0m28 0c2-4 6-4 8 0m-34 21c7 8 16 8 23 0" stroke="#214E2C" strokeWidth="3.5" strokeLinecap="round" />
    <path d="M94 33c-3-11 1-20 11-24 3 12-1 20-11 24Z" fill="#34A853" />
  </svg>;
}
export function HomeDashboard({ active, name, initialProfile, onOpenProfile, onAskFoodAI, onAskActivityAI }: { onAskFoodAI?: (date: string) => void; onAskActivityAI?: (date: string) => void; active: boolean; name: string; initialProfile: HomeProfile; onOpenProfile: () => void }) {
  const fetch = useMemberFetch(), viewingAs = useViewingAs();
  const [configuring, setConfiguring] = useState(false);
  const [date, setDate] = useState("");
  const [selectedTask, setSelectedTask] = useState("profile");
  const taskTouch = useRef<{ x: number; y: number } | null>(null);
  const [setupDialog, setSetupDialog] = useState<"food" | "activity" | null>(null);
  useEffect(() => { if (!active) { setSetupDialog(null); setConfiguring(false); } }, [active]);
  const [data, setData] = useState<HomeData | null>(null), [profile, setProfile] = useState(initialProfile), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const cache = useRef<{ value: HomeData; at: number } | null>(null);
  useEffect(() => { setProfile(initialProfile); }, [initialProfile]);
  useEffect(() => {
    const resume = () => { if (document.visibilityState !== "visible") return; setDate(localDateTime().slice(0, 10)); if (cache.current && Date.now() - cache.current.at >= 30000) setRevision(value => value + 1); };
    resume();
    window.addEventListener("focus", resume); window.addEventListener("pageshow", resume); document.addEventListener("visibilitychange", resume);
    const timer = setInterval(resume, 60000);
    return () => { window.removeEventListener("focus", resume); window.removeEventListener("pageshow", resume); document.removeEventListener("visibilitychange", resume); clearInterval(timer); };
  }, []);
  useEffect(() => {
    const changed = () => { cache.current = null; setRevision(value => value + 1); };
    const events = ["profile-saved", "food-chat-saved", "food-goals-saved", "activity-saved", "activity-goals-saved", "daywell-summary-changed"];
    for (const event of events) window.addEventListener(event, changed);
    return () => { for (const event of events) window.removeEventListener(event, changed); };
  }, []);
  useEffect(() => {
    if (!active || !date) return;
    const cached = cache.current;
    if (cached?.value.date === date && Date.now() - cached.at < 30000) { setData(cached.value); return; }
    const controller = new AbortController(); setError("");
    fetch("/api/home?date=" + date, { cache: "no-store", signal: controller.signal }).then(async response => { const body = await response.json(); if (!response.ok) { if (response.status === 401) { cache.current = null; setData(null); } throw new Error(body.message); } return body as HomeData; }).then(value => { if (controller.signal.aborted) return; cache.current = { value, at: Date.now() }; setData(value); setProfile(value.profile); }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Couldn’t load your day."); });
    return () => controller.abort();
  }, [active, date, revision, fetch]);
  const today = data?.date === date ? data : null;
  const missing = ([ ["age", "age"], ["sex", "sex"], ["heightCm", "height"], ["weightKg", "weight"] ] as const).filter(([key]) => profile[key] === null).map(([, label]) => label);
  const foodReady = !!today?.foodGoals;
  const activityReady = !!today?.activityGoals && Object.values(today.activityGoals).some(value => value !== null);
  // Cards leave the queue when their completion condition is met; future introductions can use the same shape.
  const setupTasks = [
    { key: "profile", label: "Complete your profile", complete: missing.length === 0, loading: false, detail: missing.length ? "Add your " + missing.join(", ") + " to help Kay give better estimates." : "Your details are ready.", action: onOpenProfile },
    { key: "food", label: "Set daily food goal", complete: foodReady, loading: !today, detail: "Calories, protein, carbs and fat.", action: () => setSetupDialog("food") },
    { key: "activity", label: "Set daily activity goal", complete: activityReady, loading: !today, detail: "Active calories, steps or minutes.", action: () => setSetupDialog("activity") },
  ].filter(task => !task.complete && !task.loading);
  const taskIndex = Math.max(0, setupTasks.findIndex(task => task.key === selectedTask));
  const task = setupTasks[taskIndex];
  const changeTask = (offset: number) => { const next = setupTasks[taskIndex + offset]; if (next) setSelectedTask(next.key); };
  const note = date ? dailyNotes[Math.floor(Date.parse(date + "T00:00:00Z") / 86400000) % dailyNotes.length] : "Let’s make a little room for feeling good.";
  const preferences = today?.preferences ?? defaultHomePreferences();
  return <div className="home-dashboard">
    <header className="home-greeting"><div><h1>Hi, {name.trim().split(/\s+/)[0]}.</h1><p className="home-daily-note" aria-label="Today’s thought">{note}</p></div><SmallSteps /></header>
    {task && <section className="home-task-deck" aria-label="Profile setup" aria-roledescription="carousel">
      <div className="home-task-heading"><h2>{setupTasks.length} {setupTasks.length === 1 ? "task" : "tasks"} for you</h2>
        <div className="home-task-controls"><span aria-live="polite">{taskIndex + 1} of {setupTasks.length}</span>
          <button type="button" aria-label="Previous task" disabled={taskIndex === 0} onClick={() => changeTask(-1)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5-5 5 5 5" /></svg></button>
          <button type="button" aria-label="Next task" disabled={taskIndex === setupTasks.length - 1} onClick={() => changeTask(1)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5" /></svg></button>
        </div>
      </div>
      <article className="home-task-card" key={task.key} aria-label={task.label} aria-roledescription="slide"
        onTouchStart={event => { if (event.touches.length === 1) taskTouch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }; else taskTouch.current = null; }}
        onTouchCancel={() => { taskTouch.current = null; }}
        onTouchEnd={event => { const start = taskTouch.current; taskTouch.current = null; if (!start || !event.changedTouches.length) return; const dx = event.changedTouches[0].clientX - start.x, dy = event.changedTouches[0].clientY - start.y; if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.3) { event.preventDefault(); changeTask(dx < 0 ? 1 : -1); } }}>
        <h3>{task.label}</h3><p>{task.detail}</p>
        <button className="primary-button" type="button" aria-label={task.label} disabled={task.key !== "profile" && !!viewingAs} onClick={task.action}>{task.key === "profile" && viewingAs ? "View profile" : "Set up"}</button>
      </article>
    </section>}
    {error && <p className="form-error" role="alert">{error} <button className="text-button" onClick={() => setRevision(value => value + 1)}>Try again</button></p>}
    {setupDialog === "food" && <GoalForm goals={today?.foodGoals ?? null} initialEffectiveFrom={date} onClose={() => setSetupDialog(null)} onAskAI={onAskFoodAI ? effectiveFrom => { setSetupDialog(null); onAskFoodAI(effectiveFrom); } : undefined} onSaved={() => { setSetupDialog(null); window.dispatchEvent(new Event("food-goals-saved")); }} />}
    {setupDialog === "activity" && <ActivityGoalForm goals={today?.activityGoals ?? null} date={date} onClose={() => setSetupDialog(null)} onAskAI={onAskActivityAI ? effectiveFrom => { setSetupDialog(null); onAskActivityAI(effectiveFrom); } : undefined} onSaved={() => { setSetupDialog(null); window.dispatchEvent(new Event("activity-goals-saved")); }} />}
    {today ? preferences.order.map(card => !preferences[card].visible ? null : card === "activity" ? <ActivitySummaryCard key={card} day={today.activity} goals={today.activityGoals} title="Today’s activity" metrics={(["steps", "minutes"] as const).filter(key => preferences.activity[key])} action={<button className="text-button" disabled={!!viewingAs} onClick={() => setSetupDialog("activity")}>Set goals</button>} /> : <FoodGoalPanel key={card} className="home-today-food" heading="Today’s food intake" goals={today.foodGoals} effectiveFrom={today.foodGoalEffectiveFrom} day={today.food} date={date} nutrients={(["calories", "protein", "carbs", "fat"] as const).filter(key => key === "calories" || preferences.food[key]) as GoalNutrient[]} onAskAI={onAskFoodAI} onSaved={() => window.dispatchEvent(new Event("food-goals-saved"))} />) : !error && <p className="goal-loading" role="status">Loading today’s goals…</p>}
    <div className="home-configure"><button className="text-button" disabled={!today || !!viewingAs} onClick={() => setConfiguring(true)}>Configure homepage</button></div>
    {configuring && <HomeConfiguration preferences={preferences} onClose={() => setConfiguring(false)} onSaved={value => {
      setData(current => current ? { ...current, preferences: value } : current);
      if (cache.current) cache.current = { ...cache.current, value: { ...cache.current.value, preferences: value } };
      setConfiguring(false);
    }} />}
  </div>;
}

function HomeConfiguration({ preferences, onClose, onSaved }: { preferences: HomePreferences; onClose: () => void; onSaved: (value: HomePreferences) => void }) {
  const fetch = useMemberFetch(), viewingAs = useViewingAs(), dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(preferences), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { const el = dialog.current!; el.showModal(); return () => el.close(); }, []);
  useEffect(() => { const guard = (event: Event) => { const detail = (event as CustomEvent).detail; detail.busy ||= busy; detail.dirty = true; }; window.addEventListener("daywell-update-guard", guard); return () => window.removeEventListener("daywell-update-guard", guard); }, [busy]);
  const labels = { food: "Food intake", activity: "Activity" };
  function move(card: HomeCard) { setDraft(current => ({ ...current, order: [card, current.order.find(key => key !== card)!] })); }
  return <dialog ref={dialog} className="food-dialog" aria-labelledby="home-config-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="food-form-heading"><h2 id="home-config-title">Configure homepage</h2><button className="dialog-close" aria-label="Close homepage configuration" disabled={busy} onClick={onClose}>×</button></div>
    <form onSubmit={async event => { event.preventDefault(); if (busy || viewingAs) return; setBusy(true); setError(""); try {
      const response = await fetch("/api/home", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message); onSaved(body.preferences);
    } catch (error) { setError(error instanceof Error ? error.message : "Couldn’t save your homepage."); } finally { setBusy(false); } }}>
      <div className="food-form-body"><p>Choose your cards and details. Calories stay visible on each card.</p>
        <fieldset className="home-config-options" disabled={busy || !!viewingAs}><legend className="sr-only">Homepage cards</legend>{draft.order.map((card, index) => <div className="home-config-card" key={card}>
          <div className="home-config-card-heading"><label><input type="checkbox" checked={draft[card].visible} onChange={event => { const visible = event.target.checked; setDraft(current => ({ ...current, [card]: { ...current[card], visible } })); }} />{labels[card]}</label><button type="button" className="text-button" aria-label={`Move ${labels[card]} ${index ? "up" : "down"}`} onClick={() => move(draft.order[1])}>{index ? "Move up" : "Move down"}</button></div>
          <div className="home-config-details">{(card === "food" ? [["carbs", "Carbs"], ["protein", "Protein"], ["fat", "Fat"]] as const : [["steps", "Steps"], ["minutes", "Active minutes"]] as const).map(([metric, label]) => <label key={metric}><input type="checkbox" disabled={!draft[card].visible} checked={card === "food" ? draft.food[metric as "carbs" | "protein" | "fat"] : draft.activity[metric as "steps" | "minutes"]} onChange={event => { const checked = event.target.checked; setDraft(current => ({ ...current, [card]: { ...current[card], [metric]: checked } })); }} />{label}</label>)}</div>
        </div>)}</fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div><div className="food-form-actions"><button className="cancel-food-button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !!viewingAs}>{busy ? "Saving…" : "Save homepage"}</button></div>
    </form>
  </dialog>;
}
