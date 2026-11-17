export const meals = ["breakfast", "lunch", "dinner", "snack"] as const;
export type Meal = typeof meals[number];
export type FoodCategory = "healthy" | "unhealthy";
export const MAX_CHAT_PHOTOS = 5;
export const MAX_CHAT_PHOTO_BYTES = 3 * 1024 * 1024;
export const photoModes = ["auto", "meal", "angles"] as const;
export type FoodChatPhotoMode = typeof photoModes[number];
export type FoodInput = {
  name: string; calories: number; protein: number; carbs: number; fat: number;
  meal: Meal | null; category: FoodCategory; eatenAtLocal: string; timeZone: string;
};
export type FoodEntry = FoodInput & { id: string; analysisId?: string | null; chatMessageId?: string | null };
export type FoodEstimate = Pick<FoodInput, "name" | "calories" | "fat" | "protein" | "carbs"> & {
  analysisId: string; assumptions: string;
};
export type PhotoAnalysisStatus = {
  configured: boolean; remainingToday: number; monthlyBudgetUsd: number; remainingBudgetUsd: number;
};
export type FoodChatDraft = FoodInput & FoodEstimate & { draftId: string; targetEntryId: string | null; targetSnapshot: FoodInput | null };
export type FoodChatGoalDraft = {
  kind: "goals"; draftId: string; analysisId: string;
  goals: import("./food-goals").FoodGoals; effectiveFrom: string; assumptions: string;
};
export type FoodChatPendingDraft = FoodChatDraft | FoodChatGoalDraft;
export const isGoalDraft = (draft: FoodChatPendingDraft): draft is FoodChatGoalDraft => "kind" in draft && draft.kind === "goals";
export type FoodChatMessage = {
  id: string; requestId: string; sequence: number; role: "user" | "assistant"; content: string; createdAt: string;
  payload: { state: "pending" | "failed" | "ready" | "logged" | "superseded"; hasPhoto?: boolean; photoCount?: number; photoMode?: FoodChatPhotoMode; draft?: FoodChatDraft; goalDraft?: FoodChatGoalDraft; summary?: FoodSummary; entryId?: string; operation?: "create" | "update"; error?: string; requestHash?: string };
};
export type FoodChatState = {
  chatId: string; version: number; messages: FoodChatMessage[]; hasMore: boolean;
  draft: FoodChatDraft | null; goalDraft?: FoodChatGoalDraft | null; pending: boolean; quota: PhotoAnalysisStatus;
};

export function macroCalorieEstimate(values: Pick<FoodInput, "calories" | "protein" | "carbs" | "fat">) {
  const expected = Math.round(values.protein * 4 + values.carbs * 4 + values.fat * 9);
  return Math.abs(values.calories - expected) > Math.max(50, expected * .2) ? expected : null;
}
export type FoodSummary = {
  entries: number; calories: number; protein: number; carbs: number; fat: number;
  unhealthyEntries: number; unhealthyCalories: number;
};
export type FoodJournalData = {
  entries: FoodEntry[]; day: FoodSummary; month: FoodSummary;
  goals: import("./food-goals").FoodGoals | null;
  goalEffectiveFrom: string | null;
};
export const emptySummary = (): FoodSummary => ({
  entries: 0, calories: 0, protein: 0, carbs: 0, fat: 0, unhealthyEntries: 0, unhealthyCalories: 0,
});

export function isFoodDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return year >= 2000 && year <= 2100 && new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

export function parseFood(value: unknown): FoodInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Check your food details.");
  const data = value as Record<string, unknown>;
  if (data.name !== undefined && data.name !== null && typeof data.name !== "string") throw new Error("Enter a valid food name.");
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (name.length > 120) throw new Error("Food names can be up to 120 characters.");
  const nutrients: Record<string, number> = {};
  for (const key of ["calories", "protein", "carbs", "fat"] as const) {
    const number = data[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > (key === "calories" ? 100000 : 10000) || Math.abs(number * 100 - Math.round(number * 100)) > 0.00001) {
      throw new Error("Enter non-negative nutrition values with up to two decimal places. Calories must be at most 100,000 and macros at most 10,000 g.");
    }
    nutrients[key] = number;
  }
  const meal = data.meal === undefined || data.meal === null || data.meal === "" ? null : data.meal;
  if (meal !== null && !meals.includes(meal as Meal)) throw new Error("Choose breakfast, lunch, dinner, or snack.");
  if (data.category === undefined) data.category = "healthy";
  if (data.timeZone === undefined) data.timeZone = "UTC";
  if (data.category !== "healthy" && data.category !== "unhealthy") throw new Error("Choose Healthy or Unhealthy.");
  if (typeof data.timeZone !== "string" || data.timeZone.length > 64) throw new Error("Choose a valid time zone.");
  try { new Intl.DateTimeFormat("en", { timeZone: data.timeZone }); }
  catch { throw new Error("Choose a valid time zone."); }
  let eatenAtLocal = data.eatenAtLocal;
  if (eatenAtLocal === undefined || eatenAtLocal === null || eatenAtLocal === "") {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: data.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const part = (type: string) => parts.find(item => item.type === type)!.value;
    eatenAtLocal = `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  }
  if (typeof eatenAtLocal !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(eatenAtLocal) || !isFoodDate(eatenAtLocal.slice(0, 10)) || Number(eatenAtLocal.slice(11, 13)) > 23 || Number(eatenAtLocal.slice(14, 16)) > 59) {
    throw new Error("Enter a valid date and time between 2000 and 2100.");
  }
  return {
    name, calories: nutrients.calories, protein: nutrients.protein, carbs: nutrients.carbs, fat: nutrients.fat,
    meal: meal as Meal | null, category: data.category, eatenAtLocal, timeZone: data.timeZone,
  };
}

export function localDateTime(date = new Date()) {
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function nextFoodDate(value: string, days = 1) {
  const date = new Date(value + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
