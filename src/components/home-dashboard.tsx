"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useMemberFetch, useViewingAs } from "./member-view";
import { localDateTime, type FoodSummary } from "@/lib/food";
import { foodGoalProgress, type FoodGoals } from "@/lib/food-goals";
import type { ActivityDay, ActivityGoals } from "@/lib/activity";
import type { ProfileDetails } from "@/lib/profile";
type HomeProfile = Pick<ProfileDetails, "age" | "sex" | "heightCm" | "weightKg">;
type HomeData = { date: string; activity: ActivityDay; activityGoals: ActivityGoals | null; food: Pick<FoodSummary, "entries" | "calories" | "protein" | "carbs" | "fat">; foodGoals: FoodGoals | null; profile: HomeProfile };
const format = (value: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
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
export function HomeDashboard({ active, name, initialProfile, onOpenProfile }: { active: boolean; name: string; initialProfile: HomeProfile; onOpenProfile: () => void }) {
  const fetch = useMemberFetch(), viewingAs = useViewingAs();
  const [date, setDate] = useState("");
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
    const events = ["profile-saved", "food-chat-saved", "food-goals-saved", "activity-saved", "daywell-summary-changed"];
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
  const note = date ? dailyNotes[Math.floor(Date.parse(date + "T00:00:00Z") / 86400000) % dailyNotes.length] : "Let’s make a little room for feeling good.";
  const activityGoal = today?.activityGoals?.calories;
  const foodProgress = today?.foodGoals ? foodGoalProgress(today.food.calories, today.foodGoals.calories) : null;
  return <div className="home-dashboard">
    <header className="home-greeting"><div><h1>Hi, {name.trim().split(/\s+/)[0]}.</h1><p className="home-daily-note" aria-label="Today’s thought">{note}</p></div><SmallSteps /></header>
    {missing.length > 0 && <section className="home-profile-setup" aria-label="Profile setup"><div><h2>Complete your profile</h2><p>Add your {missing.join(", ")} to help Kay give better estimates.</p></div><button className="text-button" onClick={onOpenProfile}>{viewingAs ? "View profile" : "Set up profile"}</button></section>}
    {error && <p className="form-error" role="alert">{error} <button className="text-button" onClick={() => setRevision(value => value + 1)}>Try again</button></p>}
    <section className="home-today home-today-activity" aria-labelledby="home-activity-title" aria-busy={!today && !error}>
      <div className="home-section-heading"><h2 id="home-activity-title">Today’s activity</h2><Link href="/app?tab=activity" prefetch={false}>View activity</Link></div>
      <p className="home-total"><strong>{today ? format(today.activity.calories) : "—"}</strong><span>kcal active</span></p>
      {today ? <p className="home-goal-note">{activityGoal ? today.activity.calories >= activityGoal ? `Goal achieved · ${format(activityGoal)} kcal goal` : `${format(Math.max(0, activityGoal - today.activity.calories))} kcal to your goal of ${format(activityGoal)}` : "Every bit of movement counts."}</p> : <p className="home-goal-note" role="status">{error ? "Totals unavailable" : "Loading today’s movement…"}</p>}
      {activityGoal && <progress aria-label="Today’s activity calorie goal" value={Math.min(today!.activity.calories, activityGoal)} max={activityGoal} />}
      <dl className="home-metrics home-activity-metrics"><div><dt>Steps</dt><dd>{today ? format(today.activity.steps) : "—"}</dd></div><div><dt>Active minutes</dt><dd>{today ? format(today.activity.minutes) : "—"}</dd></div></dl>
    </section>
    <section className="home-today home-today-food" aria-labelledby="home-food-title" aria-busy={!today && !error}>
      <div className="home-section-heading"><h2 id="home-food-title">Today’s food intake</h2><Link href="/app?tab=food" prefetch={false}>View food</Link></div>
      <p className="home-total"><strong>{today ? format(today.food.calories) : "—"}</strong><span>kcal eaten</span></p>
      {today ? <p className="home-goal-note">{foodProgress ? foodProgress.over > 0 ? `${format(foodProgress.over)} kcal above your range` : foodProgress.status === "within" ? "Within your calorie goal range" : `${format(foodProgress.remainingMin)} kcal to your minimum goal` : today.food.entries ? `${today.food.entries} ${today.food.entries === 1 ? "entry" : "entries"} logged today` : "A fresh page for today’s meals."}</p> : <p className="home-goal-note">{error ? "Totals unavailable" : "Loading today’s food…"}</p>}
      <dl className="home-metrics">{(["protein", "carbs", "fat"] as const).map(key => <div key={key}><dt>{key[0].toUpperCase() + key.slice(1)}</dt><dd>{today ? format(today.food[key]) : "—"}<small> g</small></dd></div>)}</dl>
    </section>
  </div>;
}
