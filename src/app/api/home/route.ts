import { db, type DatabaseRow } from "@/lib/db";
import { getMemberSession } from "@/lib/session";
import { isFoodDate, nextFoodDate } from "@/lib/food";
import { dailyTotals } from "@/lib/activity-store";
import { readProfile } from "@/lib/profile-store";
export const runtime = "nodejs";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export async function GET(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return json({ message: "Sign in to view your day." }, 401);
  const date = new URL(request.url).searchParams.get("date");
  if (!isFoodDate(date)) return json({ message: "Choose a valid date." }, 400);
  try {
    const [activity, [foodRows], [foodGoals], [activityGoals], profile] = await Promise.all([
      dailyTotals(session.user.id, date, date),
      db.execute<DatabaseRow[]>(`SELECT COUNT(*)::int AS entries, COALESCE(SUM(calories),0) AS calories, COALESCE(SUM(protein),0) AS protein, COALESCE(SUM(carbs),0) AS carbs, COALESCE(SUM(fat),0) AS fat FROM "foodEntry" WHERE "userId"=$1 AND "eatenAtLocal">=$2 AND "eatenAtLocal"<$3`, [session.user.id, date, nextFoodDate(date)]),
      db.execute<DatabaseRow[]>('SELECT targets FROM "foodGoalVersion" WHERE "userId"=$1 AND "effectiveFrom"<=$2 ORDER BY "effectiveFrom" DESC LIMIT 1', [session.user.id, date]),
      db.execute<DatabaseRow[]>('SELECT targets FROM "activityGoalVersion" WHERE "userId"=$1 AND "effectiveFrom"<=$2 ORDER BY "effectiveFrom" DESC LIMIT 1', [session.user.id, date]),
      readProfile(db, session.user.id),
    ]);
    const food = Object.fromEntries(["entries", "calories", "protein", "carbs", "fat"].map(key => [key, Number(foodRows[0][key])]));
    return json({ date, activity: activity[0] ?? { date, calories: 0, steps: 0, minutes: 0, entries: 0 }, activityGoals: activityGoals[0]?.targets ?? null, food, foodGoals: foodGoals[0]?.targets ?? null, profile: { age: profile?.age ?? null, sex: profile?.sex ?? null, heightCm: profile?.heightCm ?? null, weightKg: profile?.weightKg ?? null } });
  } catch { return json({ message: "We couldn’t load today’s totals. Please try again." }, 503); }
}
