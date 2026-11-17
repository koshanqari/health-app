import type { FoodSummary } from "./food";

export const goalNutrients = ["calories", "protein", "carbs", "fat"] as const;
export type GoalNutrient = typeof goalNutrients[number];
export type GoalRange = { min: number; max: number };
export type FoodGoals = Record<GoalNutrient, GoalRange>;
const round = (value: number) => Math.round(value * 100) / 100;

// Editable starting split, not a personalized nutrition prescription.
export function suggestedMacros(calories: number) {
  return { protein: round(calories * .25 / 4), carbs: round(calories * .5 / 4), fat: round(calories * .25 / 9) };
}

export function suggestedFoodGoals(min = 2200, max = 2500): FoodGoals {
  const lower = suggestedMacros(min), upper = suggestedMacros(max);
  return { calories: { min, max }, protein: { min: lower.protein, max: upper.protein }, carbs: { min: lower.carbs, max: upper.carbs }, fat: { min: lower.fat, max: upper.fat } };
}

export function parseFoodGoals(value: unknown): FoodGoals {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Check your goal ranges.");
  const result = {} as FoodGoals;
  for (const key of goalNutrients) {
    const range = (value as Record<string, unknown>)[key];
    if (!range || typeof range !== "object" || Array.isArray(range)) throw new Error("Set a minimum and maximum for each nutrient.");
    const { min, max } = range as Record<string, unknown>;
    const limit = key === "calories" ? 100000 : 10000;
    if ([min, max].some(number => typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > limit || Math.abs(number * 100 - Math.round(number * 100)) > .00001)) throw new Error("Use non-negative goal values with up to two decimal places.");
    if ((min as number) > (max as number)) throw new Error("Each minimum must be no greater than its maximum.");
    if (key === "calories" && (min as number) <= 0) throw new Error("The calorie minimum must be greater than zero.");
    result[key] = { min: min as number, max: max as number };
  }
  return result;
}

export function foodGoalProgress(consumed: number, range: GoalRange) {
  return {
    remainingMin: round(Math.max(0, range.min - consumed)),
    remainingMax: round(Math.max(0, range.max - consumed)),
    over: round(Math.max(0, consumed - range.max)),
    status: consumed < range.min ? "below" as const : consumed > range.max ? "over" as const : "within" as const,
    percent: range.max > 0 ? Math.min(100, Math.max(0, consumed / range.max * 100)) : consumed > 0 ? 100 : 0,
  };
}

export function goalMacroValues(goals: FoodGoals, bound: "min" | "max"): Pick<FoodSummary, GoalNutrient> {
  return { calories: goals.calories[bound], protein: goals.protein[bound], carbs: goals.carbs[bound], fat: goals.fat[bound] };
}
