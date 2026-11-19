import { isFoodDate } from "./food";

export const activityTypes = ["walking", "running", "cycling", "swimming", "strength", "badminton", "cricket", "football", "hiking", "others"] as const;
export type ActivityType = typeof activityTypes[number];
export const activityLabels: Record<ActivityType, string> = { walking: "Walking", running: "Running", cycling: "Cycling", swimming: "Swimming", strength: "Strength Training", badminton: "Badminton", cricket: "Cricket", football: "Football", hiking: "Hiking", others: "Others" };
export const activityMetrics = ["calories", "steps", "minutes"] as const;
export type ActivityMetric = typeof activityMetrics[number];
export type ActivityGoals = Record<ActivityMetric, number | null>;
export type ActivityProfile = { weightKg: number | null; age: number | null };
export type ActivityFacts = { type: ActivityType; name: string; durationMinutes: number | null; distanceKm: number | null; steps: number | null; detail: string | null; stepScope: "session" | "daily_total"; calorieSource: "estimated" | "manual" | "device" | "not_estimated"; calories: number | null; notes: string; occurredAtLocal: string; timeZone: string };
export type ActivityInput = Omit<ActivityFacts, "calories"> & { calories: number | null; weightKg: number | null; ageSnapshot: number | null; met: number | null; referenceCode: string | null; estimateVersion: string | null; assumptions: string };
export type ActivityEntry = ActivityInput & { id: string; revision: number; chatMessageId: string | null };
export type ActivityDay = Record<ActivityMetric, number> & { date: string; entries: number };
export type ActivityGoalVersion = { effectiveFrom: string; goals: ActivityGoals };
export type ActivityJournalData = { entries: ActivityEntry[]; day: ActivityDay; goals: ActivityGoals | null; goalEffectiveFrom: string | null; profile: ActivityProfile };
export type ActivityHistoryData = { start: string; end: string; days: ActivityDay[]; goalVersions: ActivityGoalVersion[] };
export const distanceActivities: ActivityType[] = ["walking", "running", "cycling"];
export const stepActivities: ActivityType[] = ["walking", "running", "hiking"];
// Selected 2024 Adult Compendium entries (ages 19–59). Keep codes with saved estimates.
// https://pacompendium.com/ : Walking, Running, Bicycling, Water Activities,
// Conditioning Exercise and Sports. Football means association football/soccer.
export const activityDetails: Partial<Record<ActivityType, { key: string; label: string; met: number; code: string }[]>> = {
  swimming: [{ key: "freestyle_easy", label: "Freestyle, recreational", met: 5.8, code: "18240" }, { key: "freestyle_fast", label: "Freestyle, vigorous", met: 9.8, code: "18230" }, { key: "backstroke", label: "Backstroke, recreational", met: 4.8, code: "18255" }, { key: "breaststroke", label: "Breaststroke, recreational", met: 5.3, code: "18265" }, { key: "butterfly", label: "Butterfly", met: 13.8, code: "18270" }],
  strength: [{ key: "general", label: "General resistance training", met: 3.5, code: "02054" }, { key: "vigorous", label: "Vigorous lifting", met: 6, code: "02050" }],
  badminton: [{ key: "social", label: "Social play", met: 5.5, code: "15030" }, { key: "competitive", label: "Competitive play", met: 7, code: "15020" }],
  football: [{ key: "casual", label: "Casual play", met: 7, code: "15610" }, { key: "competitive", label: "Competitive play", met: 9.5, code: "15605" }],
  hiking: [{ key: "easy", label: "Slow, no pack", met: 3.8, code: "17081" }, { key: "hills", label: "Fields and hills, normal effort", met: 5.3, code: "17082" }, { key: "cross_country", label: "Cross-country terrain", met: 6, code: "17080" }, { key: "daypack", label: "Hiking with a daypack", met: 7.8, code: "17012" }],
};
const round = (n: number) => Math.round(n * 100) / 100;
function numeric(value: unknown, label: string, max: number, decimals = 2, zero = false): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < (zero ? 0 : .001) || value > max || Math.abs(value * 10 ** decimals - Math.round(value * 10 ** decimals)) > .000001) throw new Error(`Check ${label}; use a number ${zero ? "from 0" : "above 0"} up to ${max}.`);
  return value;
}
export function parseActivityFacts(value: unknown, now = new Date()): ActivityFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Check your activity details.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !["type", "name", "durationMinutes", "distanceKm", "steps", "detail", "stepScope", "calorieSource", "calories", "notes", "occurredAtLocal", "timeZone"].includes(key))) throw new Error("Only activity details can be changed here.");
  if (!activityTypes.includes(data.type as ActivityType)) throw new Error("Choose an activity.");
  const type = data.type as ActivityType;
  const name = data.name == null || data.name === "" ? (data.stepScope === "daily_total" ? "Daily steps" : activityLabels[type]) : data.name;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Use an activity name up to 120 characters.");
  const notes = data.notes ?? "";
  if (typeof notes !== "string" || notes.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)) throw new Error("Keep notes within 500 characters.");
  const durationMinutes = numeric(data.durationMinutes, "duration in minutes", 1440);
  const distanceKm = numeric(data.distanceKm, "distance in km", 1000, 3);
  const steps = numeric(data.steps, "steps", 200000, 0, true);
  if (steps !== null && !stepActivities.includes(type)) throw new Error("Steps are available for walking, running and hiking.");
  if (distanceKm !== null && ![...distanceActivities, "swimming", "hiking"].includes(type)) throw new Error("Distance is not used for this activity.");
  const detail = data.detail === "" || data.detail == null ? null : data.detail;
  if (detail !== null && !activityDetails[type]?.some(option => option.key === detail)) throw new Error("Choose a valid activity detail.");
  const stepScope = data.stepScope ?? "session";
  if (!["session", "daily_total"].includes(String(stepScope)) || (stepScope === "daily_total" && type !== "walking")) throw new Error("Daily step totals use Walking.");
  if (stepScope === "daily_total" && (steps === null || durationMinutes !== null || distanceKm !== null)) throw new Error("A daily step total needs steps only, without a session duration or distance.");
  const calorieSource = data.calorieSource ?? (type === "others" ? "manual" : "estimated");
  if (!["estimated", "manual", "device", "not_estimated"].includes(String(calorieSource))) throw new Error("Choose how to log active calories.");
  const calories = numeric(data.calories, "active calories", 50000, 2, true);
  if (["manual", "device"].includes(String(calorieSource)) && calories === null) throw new Error("Enter the active calories burned.");
  if (calorieSource === "not_estimated" && (steps === null || !stepActivities.includes(type) || calories !== null)) throw new Error("Steps-only logging needs a step count and leaves calories unestimated.");
  if (stepScope === "daily_total" && calorieSource !== "not_estimated") throw new Error("Daily step totals leave calories unestimated. Log a workout separately for active calories.");
  if (calorieSource === "estimated" && calories !== null) throw new Error("Choose entered or device calories when supplying a calorie value.");
  const timeZone = data.timeZone ?? "UTC";
  if (typeof timeZone !== "string" || timeZone.length > 64) throw new Error("Choose a valid time zone.");
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now); } catch { throw new Error("Choose a valid time zone."); }
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  const occurredAtLocal = data.occurredAtLocal || `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  if (typeof occurredAtLocal !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(occurredAtLocal) || !isFoodDate(occurredAtLocal.slice(0, 10)) || Number(occurredAtLocal.slice(11, 13)) > 23 || Number(occurredAtLocal.slice(14)) > 59) throw new Error("Choose a valid activity date and time.");
  return { type, stepScope: stepScope as ActivityFacts["stepScope"], name: name.trim(), notes: notes.trim(), durationMinutes, distanceKm, steps, detail: detail as string | null, calorieSource: calorieSource as ActivityFacts["calorieSource"], calories, occurredAtLocal, timeZone };
}

// Upper speed bounds in mph; distances and durations are the only speed inputs.
const speedTables: Record<"walking" | "running" | "cycling", [number, number, string][]> = {
  walking: [[2, 2.3, "17151"], [2.5, 2.8, "17152"], [2.8, 3, "17170"], [3.5, 3.8, "17190"], [4, 4.8, "17200"], [4.5, 5.5, "17220"], [5, 7, "17230"], [5.6, 8.5, "17231"]],
  running: [[3.8, 3.3, "12026"], [4.25, 6.5, "12028"], [4.9, 7.8, "12029"], [5.35, 8.5, "12030"], [5.95, 9, "12045"], [6.5, 9.3, "12050"], [6.85, 10.5, "12060"], [7.25, 11, "12070"], [7.75, 11.8, "12080"], [8.3, 12, "12090"], [8.8, 12.5, "12100"], [9.15, 13, "12110"], [10.5, 14.8, "12120"], [11.5, 16.8, "12130"], [12.5, 18.5, "12132"], [13.5, 19.8, "12134"], [14.1, 23, "12135"]],
  cycling: [[10, 4, "01010"], [12, 6.8, "01020"], [14, 8, "01030"], [16, 10, "01040"], [20, 12, "01050"], [35, 16.8, "01060"]],
};
export function resolveActivity(value: unknown, profile: ActivityProfile, previous?: ActivityInput): ActivityInput {
  const facts = parseActivityFacts(value);
  if (facts.calorieSource === "not_estimated") return { ...facts, calories: null, weightKg: null, ageSnapshot: null, met: null, referenceCode: null, estimateVersion: null, assumptions: facts.stepScope === "daily_total" ? "Daily step total; includes steps from any walks already logged. Calories not estimated." : "Steps recorded; calories not estimated." };
  if (facts.calorieSource !== "estimated") return { ...facts, calories: facts.calories!, weightKg: null, ageSnapshot: null, met: null, referenceCode: null, estimateVersion: null, assumptions: "Active calories supplied by " + (facts.calorieSource === "device" ? "your device." : "you.") };
  if (facts.type === "others") throw new Error("Enter active calories for Others.");
  const snapshot = previous?.calorieSource === "estimated" ? { weightKg: previous.weightKg, age: previous.ageSnapshot } : profile;
  if (!snapshot.weightKg || snapshot.weightKg <= 0 || snapshot.weightKg > 500) throw new Error("Add your weight in Profile to estimate active calories, or enter calories yourself.");
  if (snapshot.age !== null && (snapshot.age < 19 || snapshot.age > 59)) throw new Error("These estimates use adult reference values for ages 19–59. Enter your active calories instead.");
  if (!facts.durationMinutes) throw new Error("Enter the activity duration to estimate active calories.");
  let met: number, referenceCode: string, assumptions: string;
  if (distanceActivities.includes(facts.type)) {
    if (!facts.distanceKm) throw new Error("Enter duration and distance; speed is calculated automatically.");
    const mph = facts.distanceKm / (facts.durationMinutes / 60) / 1.609344;
    const table = speedTables[facts.type as keyof typeof speedTables];
    if (mph < (facts.type === "running" ? 2.6 : .3) || mph > table[table.length - 1][0]) throw new Error("Check distance and duration; this speed is outside the supported estimate range. You can enter calories yourself.");
    const row = table.find(row => mph < row[0]) ?? table[table.length - 1];
    [, met, referenceCode] = row;
    assumptions = facts.type === "cycling" ? "Outdoor, non-assisted cycling; speed derived from distance and duration." : "Level, firm surface; speed derived from distance and duration.";
  } else if (facts.type === "cricket") { met = 4.8; referenceCode = "15150"; assumptions = "Batting, bowling or fielding time; excludes waiting and breaks."; }
  else {
    const detail = activityDetails[facts.type]?.find(option => option.key === facts.detail);
    if (!detail) throw new Error("Choose activity details to estimate active calories.");
    met = detail.met; referenceCode = detail.code; assumptions = detail.label + (facts.type === "football" ? "; association football (soccer)." : ".");
  }
  return { ...facts, calories: round((met - 1) * 3.5 * snapshot.weightKg / 200 * facts.durationMinutes), weightKg: snapshot.weightKg, ageSnapshot: snapshot.age, met, referenceCode, estimateVersion: "adult-compendium-2024-net-v1", assumptions: assumptions + " Adult reference estimate" + (snapshot.age === null ? "; age not supplied." : ".") };
}
export function activityFacts(value: ActivityInput): ActivityFacts {
  return { type: value.type, stepScope: value.stepScope ?? "session", name: value.name, notes: value.notes, durationMinutes: value.durationMinutes, distanceKm: value.distanceKm, steps: value.steps, detail: value.detail, calorieSource: value.calorieSource, calories: value.calorieSource === "estimated" ? null : value.calories, occurredAtLocal: value.occurredAtLocal, timeZone: value.timeZone };
}
export function parseActivityGoals(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !activityMetrics.includes(key as ActivityMetric))) throw new Error("Check your activity goals.");
  const data = value as Record<string, unknown>;
  return { calories: numeric(data.calories, "calorie target", 100000), steps: numeric(data.steps, "step target", 200000, 0), minutes: numeric(data.minutes, "minute target", 1440) } as ActivityGoals;
}

// The model proposes facts; only the server estimates calories. Missing facts are
// conversational clarifications, not provider failures. Manual form parsing stays strict.
export function prepareActivityChatProposal(value: unknown, profile: ActivityProfile, timeZone: string): { activity: ActivityInput; question?: never } | { activity?: never; question: string } {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const candidate = { ...raw, timeZone, ...(raw.calorieSource === "estimated" || (raw.calorieSource === undefined && raw.type !== "others") ? { calories: null } : {}) };
  let facts: ActivityFacts;
  try { facts = parseActivityFacts(candidate); }
  catch (error) {
    // A model may return prose such as "moderate" for a reference key. Retain
    // the supplied time/steps and ask the user to choose a supported detail.
    if (raw.detail != null) {
      try {
        const withoutDetail = parseActivityFacts({ ...candidate, detail: null });
        const question = activityDetailQuestion(withoutDetail);
        if (question) return { question };
      } catch { /* Other invalid facts need correction first. */ }
    }
    return { question: "Could you check the activity details? " + (error instanceof Error ? error.message : "Tell me the activity and duration in minutes.") };
  }
  if (facts.calorieSource === "estimated") {
    const missing: string[] = [];
    if (!profile.weightKg) missing.push("your current weight in kg (you can tell me here or add it in Profile)");
    if (!facts.durationMinutes) missing.push("the activity duration in minutes");
    if (distanceActivities.includes(facts.type) && !facts.distanceKm) missing.push("the distance in km");
    if (missing.length) return { question: "To estimate active calories for " + activityLabels[facts.type].toLowerCase() + ", please share " + missing.join(" and ") + "." };
    const question = !facts.detail ? activityDetailQuestion(facts) : null;
    if (question) return { question };
  }
  try { return { activity: resolveActivity(facts, profile) }; }
  catch (error) { return { question: error instanceof Error ? error.message : "Please confirm the activity details." }; }
}
function activityDetailQuestion(facts: ActivityFacts): string | null {
  if (facts.calorieSource !== "estimated" || !activityDetails[facts.type]) return null;
  const duration = facts.durationMinutes ? " I have the " + facts.durationMinutes + "-minute duration." : "";
  const questions = {
    badminton: "Was the badminton social/casual or competitive?",
    football: "Was the football casual or competitive?",
    strength: "Was the strength training general resistance training or vigorous lifting?",
    swimming: "Which swimming style did you use: recreational freestyle, vigorous freestyle, backstroke, breaststroke or butterfly?",
    hiking: "Was the hike slow with no pack, at a normal effort through hills, cross-country, or with a daypack?",
  };
  return questions[facts.type as keyof typeof questions] + duration;
}
