import { nextFoodDate, type FoodSummary } from "./food";
import type { FoodGoals, GoalNutrient } from "./food-goals";

export const historyPeriods = ["W", "M", "6M", "Y"] as const;
export type HistoryPeriod = typeof historyPeriods[number];
export type FoodHistoryDay = Pick<FoodSummary, GoalNutrient | "entries"> & { date: string };
export type FoodHistoryData = { start: string; end: string; days: FoodHistoryDay[]; goals: FoodGoals | null };
const iso = (date: Date) => date.toISOString().slice(0, 10);

export function foodHistoryWindow(period: HistoryPeriod, anchor: string) {
  const date = new Date(anchor + "T12:00:00Z"), year = date.getUTCFullYear(), month = date.getUTCMonth();
  if (period === "W") {
    const start = nextFoodDate(anchor, -((date.getUTCDay() + 6) % 7));
    const end = nextFoodDate(start, 6);
    return { start: start < "2000-01-01" ? "2000-01-01" : start, end: end > "2100-12-31" ? "2100-12-31" : end };
  }
  const start = iso(new Date(Date.UTC(year, period === "Y" ? 0 : period === "6M" ? month - 5 : month, 1)));
  const end = iso(new Date(Date.UTC(year, period === "Y" ? 12 : month + 1, 0)));
  return { start: start < "2000-01-01" ? "2000-01-01" : start, end };
}

export function shiftHistoryAnchor(period: HistoryPeriod, anchor: string, direction: number) {
  if (period === "W") return nextFoodDate(anchor, direction * 7);
  const date = new Date(anchor + "T12:00:00Z");
  return iso(new Date(Date.UTC(date.getUTCFullYear() + (period === "Y" ? direction : 0), date.getUTCMonth() + (period === "M" ? direction : period === "6M" ? direction * 6 : 0), 1)));
}

export function historyDayStatus(day: FoodHistoryDay, goals: FoodGoals | null, nutrient: GoalNutrient, today: string) {
  if (day.date > today) return "future";
  if (!day.entries) return "unlogged";
  if (!goals) return "no-goal";
  return day[nutrient] >= goals[nutrient].min && day[nutrient] <= goals[nutrient].max ? "achieved" : "outside";
}

export function completeHistoryDays(start: string, end: string, rows: FoodHistoryDay[]): FoodHistoryDay[] {
  const byDate = new Map(rows.map(day => [day.date, day]));
  const days: FoodHistoryDay[] = [];
  for (let date = start; date <= end; date = nextFoodDate(date)) days.push(byDate.get(date) ?? { date, entries: 0, calories: 0, protein: 0, carbs: 0, fat: 0 });
  return days;
}
