import { db, type DatabaseRow } from "@/lib/db";
import { getMemberSession } from "@/lib/session";
import { isFoodDate, nextFoodDate } from "@/lib/food";
import { dailyTotals } from "@/lib/activity-store";
import { readProfile } from "@/lib/profile-store";
import { defaultHomePreferences, parseHomePreferences } from "@/lib/home-preferences";
import { trustedAppOrigins } from "@/lib/app-origins";
export const runtime = "nodejs";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export async function GET(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return json({ message: "Sign in to view your day." }, 401);
  const date = new URL(request.url).searchParams.get("date");
  if (!isFoodDate(date)) return json({ message: "Choose a valid date." }, 400);
  try {
    const [activity, [foodRows], [foodGoals], [activityGoals], profile, [preferences]] = await Promise.all([
      dailyTotals(session.user.id, date, date),
      db.execute<DatabaseRow[]>(`SELECT COUNT(*)::int AS entries, COALESCE(SUM(calories),0) AS calories, COALESCE(SUM(protein),0) AS protein, COALESCE(SUM(carbs),0) AS carbs, COALESCE(SUM(fat),0) AS fat FROM "foodEntry" WHERE "userId"=$1 AND "eatenAtLocal">=$2 AND "eatenAtLocal"<$3`, [session.user.id, date, nextFoodDate(date)]),
      db.execute<DatabaseRow[]>('SELECT targets, to_char("effectiveFrom", \'YYYY-MM-DD\') AS "effectiveFrom" FROM "foodGoalVersion" WHERE "userId"=$1 AND "effectiveFrom"<=$2 ORDER BY "effectiveFrom" DESC LIMIT 1', [session.user.id, date]),
      db.execute<DatabaseRow[]>('SELECT targets FROM "activityGoalVersion" WHERE "userId"=$1 AND "effectiveFrom"<=$2 ORDER BY "effectiveFrom" DESC LIMIT 1', [session.user.id, date]),
      readProfile(db, session.user.id),
      db.execute<DatabaseRow[]>('SELECT "homePreferences" FROM "userProfile" WHERE "userId"=$1', [session.user.id]),
    ]);
    const food = Object.fromEntries(["entries", "calories", "protein", "carbs", "fat"].map(key => [key, Number(foodRows[0][key])]));
    return json({ date, activity: activity[0] ?? { date, calories: 0, steps: 0, minutes: 0, entries: 0 }, activityGoals: activityGoals[0]?.targets ?? null, food, foodGoals: foodGoals[0]?.targets ?? null, foodGoalEffectiveFrom: foodGoals[0]?.effectiveFrom ?? null, preferences: preferences[0]?.homePreferences ?? defaultHomePreferences(), profile: { age: profile?.age ?? null, sex: profile?.sex ?? null, heightCm: profile?.heightCm ?? null, weightKg: profile?.weightKg ?? null } });
  } catch { return json({ message: "We couldn’t load today’s totals. Please try again." }, 503); }
}

export async function PATCH(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return json({ message: "Sign in to configure your homepage." }, 401);
  if (session.readOnly) return json({ message: "Viewing as a user is read-only." }, 403);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return json({ message: "This request is not allowed." }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ message: "Send homepage options as JSON." }, 415);
  if (Number(request.headers.get("content-length")) > 4096) return json({ message: "These options are too large." }, 413);
  let preferences;
  try {
    const text = await request.text();
    if (text.length > 4096) return json({ message: "These options are too large." }, 413);
    preferences = parseHomePreferences(JSON.parse(text));
  } catch (error) { return json({ message: error instanceof Error ? error.message : "Check your homepage options." }, 400); }
  try {
    await db.execute(`INSERT INTO "userProfile" ("userId", "homePreferences") VALUES ($1,$2::jsonb)
      ON CONFLICT ("userId") DO UPDATE SET "homePreferences"=EXCLUDED."homePreferences", "updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`, [session.user.id, JSON.stringify(preferences)]);
    return json({ preferences });
  } catch { return json({ message: "We couldn’t save your homepage. Please try again." }, 503); }
}
