import { db, type DatabaseRow } from "@/lib/db";
import { getSession } from "@/lib/session";
import { isFoodDate, nextFoodDate } from "@/lib/food";
import { completeHistoryDays, foodHistoryWindow, historyPeriods, type FoodHistoryDay, type HistoryPeriod } from "@/lib/food-history";
import { goalVersionForDate, type FoodGoalVersion } from "@/lib/food-goals";

export const runtime = "nodejs";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return response({ message: "Sign in to see your food history." }, 401);
  const params = new URL(request.url).searchParams, period = params.get("period"), anchor = params.get("date");
  if (!historyPeriods.includes(period as HistoryPeriod) || !isFoodDate(anchor)) return response({ message: "Choose a valid period and date." }, 400);
  const { start, end } = foodHistoryWindow(period as HistoryPeriod, anchor);
  try {
    const [[rows], [goalRows]] = await Promise.all([
      db.execute<DatabaseRow[]>(`SELECT to_char("eatenAtLocal", 'YYYY-MM-DD') AS date, COUNT(*)::integer AS entries,
        SUM(calories) AS calories, SUM(protein) AS protein, SUM(carbs) AS carbs, SUM(fat) AS fat
        FROM "foodEntry" WHERE "userId" = $1 AND "eatenAtLocal" >= $2 AND "eatenAtLocal" < $3
        GROUP BY to_char("eatenAtLocal", 'YYYY-MM-DD') ORDER BY date`, [session.user.id, start, nextFoodDate(end)]),
      db.execute<DatabaseRow[]>(`SELECT targets, to_char("effectiveFrom", 'YYYY-MM-DD') AS "effectiveFrom"
        FROM "foodGoalVersion" WHERE "userId" = $1 AND "effectiveFrom" <= $3::date
        AND ("effectiveFrom" >= $2::date OR "effectiveFrom" = (
          SELECT MAX("effectiveFrom") FROM "foodGoalVersion" WHERE "userId" = $1 AND "effectiveFrom" < $2::date
        )) ORDER BY "effectiveFrom"`, [session.user.id, start, end]),
    ]);
    const totals = rows.map(row => ({ date: row.date, entries: Number(row.entries), calories: Number(row.calories), protein: Number(row.protein), carbs: Number(row.carbs), fat: Number(row.fat) })) as FoodHistoryDay[];
    const goalVersions = goalRows.map(row => ({ effectiveFrom: row.effectiveFrom, goals: row.targets })) as FoodGoalVersion[];
    return response({ start, end, days: completeHistoryDays(start, end, totals), goals: goalVersionForDate(goalVersions, anchor)?.goals ?? null, goalVersions });
  } catch { return response({ message: "We couldn’t load your food history. Please try again." }, 503); }
}
