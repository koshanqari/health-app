export type HomeCard = "food" | "activity";
export type HomePreferences = {
  order: HomeCard[];
  food: { visible: boolean; carbs: boolean; protein: boolean; fat: boolean };
  activity: { visible: boolean; steps: boolean; minutes: boolean };
};
export function defaultHomePreferences(): HomePreferences {
  return { order: ["activity", "food"], food: { visible: true, carbs: true, protein: true, fat: true }, activity: { visible: true, steps: true, minutes: true } };
}
export function parseHomePreferences(value: unknown): HomePreferences {
  const fail = () => { throw new Error("Choose valid homepage options."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 3 || !Array.isArray(data.order) || data.order.length !== 2 || new Set(data.order).size !== 2 || data.order.some(key => key !== "food" && key !== "activity")) return fail();
  for (const [key, fields] of [["food", ["visible", "carbs", "protein", "fat"]], ["activity", ["visible", "steps", "minutes"]]] as const) {
    const options = data[key];
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).length !== fields.length || fields.some(field => typeof (options as Record<string, unknown>)[field] !== "boolean")) return fail();
  }
  return { order: [...data.order] as HomeCard[], food: { ...(data.food as HomePreferences["food"]) }, activity: { ...(data.activity as HomePreferences["activity"]) } };
}
