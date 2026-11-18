"use client";

import { useMemberFetch } from "./member-view";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronIcon } from "./app-header";
import { isFoodDate, localDateTime } from "@/lib/food";
import { goalNutrients, goalVersionForDate, type GoalNutrient } from "@/lib/food-goals";
import { foodHistoryWindow, historyDayStatus, historyPeriods, shiftHistoryAnchor, type FoodHistoryData, type HistoryPeriod } from "@/lib/food-history";

const labels = { calories: "Calories", protein: "Protein", carbs: "Carbs", fat: "Fat" };
const format = (value: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
const dateLabel = (date: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) => new Intl.DateTimeFormat("en-GB", options).format(new Date(date + "T12:00:00Z"));

export function FoodHistory({ active, date, revision, onSelectDate }: { active: boolean; date: string; revision: number; onSelectDate: (value: string) => void }) {
  const fetch = useMemberFetch();
  const [period, setPeriod] = useState<HistoryPeriod>("W");
  const [anchor, setAnchor] = useState(date);
  const [nutrient, setNutrient] = useState<GoalNutrient>("calories");
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<FoodHistoryData | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const cache = useRef(new Map<string, { value: FoodHistoryData; at: number }>());
  const lastRevision = useRef(revision), lastDate = useRef(date);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  const today = localDateTime().slice(0, 10);
  const range = foodHistoryWindow(period, anchor);
  const key = `${period}:${range.start}:${range.end}`;
  const visible = data?.start === range.start && data.end === range.end ? data : null;
  const versionsByDay = useMemo(() => new Map(visible?.days.map(day => [day.date, goalVersionForDate(visible.goalVersions ?? [], day.date)])), [visible]);

  // A bar selection keeps its window; the meal date picker can navigate elsewhere.
  useEffect(() => {
    if (lastDate.current === date) return;
    lastDate.current = date;
    setSelected(date);
    const current = foodHistoryWindow(period, anchor);
    if (date < current.start || date > current.end) setAnchor(date);
  }, [date]);

  useEffect(() => {
    if (lastRevision.current !== revision) { cache.current.clear(); lastRevision.current = revision; }
    if (!active) return;
    const cached = cache.current.get(key);
    setData(cached?.value ?? null); setError("");
    if (cached && Date.now() - cached.at < 30000) return;
    const controller = new AbortController();
    fetch(`/api/food/history?period=${period}&date=${anchor}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) {
          if (response.status === 401) { cache.current.clear(); setData(null); }
          throw new Error(body.message || "We couldn’t load your food history.");
        }
        return body as FoodHistoryData;
      })
      .then(value => {
        if (controller.signal.aborted) return;
        cache.current.set(key, { value, at: Date.now() });
        if (cache.current.size > 24) cache.current.delete(cache.current.keys().next().value!);
        setData(value);
      })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "We couldn’t load your food history."); });
    return () => controller.abort();
  }, [active, key, revision, retry]);

  useEffect(() => {
    if (!active) return;
    const refresh = () => { const cached = cache.current.get(key); if (document.visibilityState === "visible" && cached && Date.now() - cached.at >= 30000) setRetry(value => value + 1); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [active, key]);

  function move(direction: number) {
    const next = shiftHistoryAnchor(period, anchor, direction), nextRange = foodHistoryWindow(period, next);
    if (nextRange.start < "2000-01-01" || next < "2000-01-01" || (direction > 0 && nextRange.start > foodHistoryWindow(period, today).start) || next > "2100-12-31") return;
    setAnchor(next); setSelected(null);
  }

  function choose(index: number) {
    const day = visible?.days[index];
    if (!day || day.date > today) return;
    setSelected(day.date); onSelectDate(day.date);
  }

  function release(event: PointerEvent<HTMLDivElement>) {
    const initial = pointer.current; pointer.current = null;
    if (!initial) return;
    const dx = event.clientX - initial.x, dy = event.clientY - initial.y;
    if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy) * 1.3) { move(dx > 0 ? -1 : 1); return; }
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12 || !visible) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    choose(Math.max(0, Math.min(visible.days.length - 1, Math.floor((event.clientX - bounds.left) / bounds.width * visible.days.length))));
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!visible || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const last = visible.days.findLastIndex(day => day.date <= today);
    const current = selected ? visible.days.findIndex(day => day.date === selected) : last;
    choose(event.key === "Home" ? 0 : event.key === "End" ? last : Math.max(0, Math.min(last, current + (event.key === "ArrowLeft" ? -1 : 1))));
  }

  const selectedDay = visible?.days.find(day => day.date === selected);
  const loggedDays = visible?.days.filter(day => day.entries && day.date <= today) ?? [];
  const total = selectedDay ? selectedDay[nutrient] : loggedDays.length ? loggedDays.reduce((sum, day) => sum + day[nutrient], 0) / loggedDays.length : 0;
  const achieved = loggedDays.filter(day => historyDayStatus(day, versionsByDay.get(day.date)?.goals ?? null, nutrient, today) === "achieved").length;
  const selectedVersion = selectedDay ? versionsByDay.get(selectedDay.date) : null;
  const datedDays = visible?.days.filter(day => day.date <= today) ?? [];
  const appliedDates = new Set(datedDays.map(day => versionsByDay.get(day.date)?.effectiveFrom ?? null));
  const firstVersion = datedDays.map(day => versionsByDay.get(day.date)).find(Boolean);
  const goal = selectedDay ? selectedVersion?.goals[nutrient] : appliedDates.size === 1 ? firstVersion?.goals[nutrient] : null;
  const hasGoals = !!firstVersion;
  const noGoalDays = loggedDays.filter(day => !versionsByDay.get(day.date)).length;
  const rawMax = Math.max(1, ...(visible?.days.map(day => Math.max(day[nutrient], versionsByDay.get(day.date)?.goals[nutrient].max ?? 0)) ?? [0]));
  const step = Math.pow(10, Math.floor(Math.log10(rawMax))) / 2;
  const maximum = Math.ceil(rawMax * 1.1 / step) * step;
  const selectedIndex = visible?.days.findIndex(day => day.date === selected) ?? -1;
  const unit = nutrient === "calories" ? "kcal" : "g";
  const selectedStatus = selectedDay ? historyDayStatus(selectedDay, selectedVersion?.goals ?? null, nutrient, today) : null;
  const ticks = visible?.days.map((day, index) => ({ day, index })).filter(({ day, index }) => period === "W" || period === "M" ? period === "W" || index === 0 || (index + 1) % 7 === 0 : day.date.endsWith("-01") && (period !== "Y" || Number(day.date.slice(5, 7)) % 2 === 1)) ?? [];

  return <section className="food-history" aria-label="Food goal history">
    <div className="history-heading"><h2>Food history</h2><div className="history-periods" role="group" aria-label="History period">{historyPeriods.map(value => <button key={value} aria-pressed={period === value} onClick={() => { setAnchor(selected ?? anchor); setPeriod(value); setSelected(null); }}>{value}</button>)}</div></div>
    <div className="history-metrics" role="group" aria-label="History nutrient">{goalNutrients.map(value => <button key={value} aria-pressed={nutrient === value} onClick={() => setNutrient(value)}>{labels[value]}</button>)}</div>
    <div className="history-period-navigation">
      <button className="date-arrow" aria-label="Previous period" disabled={range.start === "2000-01-01"} onClick={() => move(-1)}><ChevronIcon direction="left" /></button>
      <label className="history-date-picker">
        <span aria-hidden="true">{dateLabel(range.start, { day: "numeric", month: "short" })} – {dateLabel(range.end)}</span>
        <input type="date" aria-label="Choose history date" min="2000-01-01" max={today} value={selected ?? anchor} onClick={event => {
          try { event.currentTarget.showPicker?.(); } catch { /* Native input remains available when showPicker is unsupported. */ }
        }} onChange={event => {
          const value = event.target.value;
          if (!isFoodDate(value) || value > today) return;
          setAnchor(value); setSelected(value); onSelectDate(value);
        }} />
      </label>
      <button className="date-arrow" aria-label="Next period" disabled={range.start >= foodHistoryWindow(period, today).start} onClick={() => move(1)}><ChevronIcon direction="right" /></button>
    </div>
    {error && <div className="form-error" role="alert">{error} <button className="text-button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
    {!visible && !error && <div className="history-loading" role="status">Loading food history…</div>}
    {visible && <>
      <div className="history-inspection" aria-live="polite" aria-atomic="true">
        <div><p className="history-caption">{selectedDay ? "Total" : "Daily average"}</p><p className="history-value"><strong>{format(total)}</strong><span>{unit}</span></p>
        <p className="history-detail">{selectedDay ? `${dateLabel(selectedDay.date)}${selectedDay.date === today ? " · so far" : ""}${!selectedDay.entries ? " · No food logged" : selectedStatus === "achieved" ? " · In goal range" : selectedStatus === "outside" ? " · Outside goal range" : selectedStatus === "no-goal" ? " · No goal set" : ""}` : `Across ${loggedDays.length} logged ${loggedDays.length === 1 ? "day" : "days"}`}</p></div>
        {selectedDay && <button className="text-button" onClick={() => setSelected(null)}>Show average</button>}
      </div>
      {selectedDay && <p className="history-day-macros">{goalNutrients.filter(key => key !== nutrient).map(key => <span key={key}>{labels[key]} {format(selectedDay[key])} {key === "calories" ? "kcal" : "g"}</span>)}</p>}
      <div className="history-graph">
        <div ref={plot} className="history-canvas" role="group" tabIndex={0} aria-label="Daily nutrition chart. Use arrow keys to select a day." onKeyDown={keyboard} onPointerDown={event => { pointer.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerUp={release} onPointerCancel={() => { pointer.current = null; }}>
          <svg viewBox="0 0 1000 240" preserveAspectRatio="none" aria-hidden="true">
            {visible.days.map((day, index) => {
              const target = versionsByDay.get(day.date)?.goals[nutrient];
              return target && day.date <= today && <rect key={day.date} x={index / visible.days.length * 1000} y={240 - target.max / maximum * 240} width={1000 / visible.days.length} height={(target.max - target.min) / maximum * 240} className="history-goal-band" />;
            })}
            {[0, 1, 2, 3].map(tick => <line key={tick} x1="0" x2="1000" y1={tick * 80} y2={tick * 80} className="history-gridline" vectorEffect="non-scaling-stroke" />)}
            {visible.days.map((day, index) => {
              const cell = 1000 / visible.days.length, width = cell * (period === "W" ? .55 : .7), height = Math.max(day.entries && day.date <= today ? 2 : 0, day.date <= today ? day[nutrient] / maximum * 240 : 0);
              const status = historyDayStatus(day, versionsByDay.get(day.date)?.goals ?? null, nutrient, today);
              return <rect key={day.date} x={index * cell + (cell - width) / 2} y={240 - Math.max(height, 1)} width={width} height={Math.max(height, 1)} rx={Math.min(width / 4, 5)} className={`history-bar history-${status}`} data-date={day.date} data-status={status} />;
            })}
            {selectedIndex >= 0 && <line x1={(selectedIndex + .5) / visible.days.length * 1000} x2={(selectedIndex + .5) / visible.days.length * 1000} y1="0" y2="240" className="history-selection" vectorEffect="non-scaling-stroke" />}
          </svg>
        </div>
        <div className="history-y-axis" aria-hidden="true">{[maximum, maximum * 2 / 3, maximum / 3, 0].map((value, index) => <span key={index}>{new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value)}</span>)}</div>
        <div className="history-x-axis" aria-hidden="true">{ticks.map(({ day, index }) => <span key={day.date} style={{ left: `${(index + .5) / visible.days.length * 100}%` }}>{dateLabel(day.date, period === "W" ? { weekday: "short" } : period === "M" ? { day: "numeric" } : { month: "short" })}</span>)}</div>
      </div>
      <div className="history-legend"><span><i className="history-achieved-dot" />In goal range</span><span><i className="history-outside-dot" />Other logged days</span>{noGoalDays > 0 && <span><i className="history-no-goal-dot" />No goal set</span>}</div>
      <p className="history-achievement">{hasGoals ? <><strong>{achieved}</strong> {achieved === 1 ? "day" : "days"} in your {nutrient === "calories" ? "calorie" : labels[nutrient].toLowerCase()} range{goal ? ` · ${format(goal.min)}–${format(goal.max)} ${unit}` : " · Goals vary by date"}</> : "No goal set for this period. Add a dated goal above."}</p>
      {selectedDay && !selectedVersion && <p className="history-footnote">No goal set for this date; this day is not counted as achieved or missed.</p>}
      <p className="history-footnote">Uses the goal that applied on each day. Tap a day for totals. Swipe to change period.</p>
    </>}
  </section>;
}
