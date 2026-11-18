import { randomUUID } from "node:crypto";
import type { DatabaseChange, DatabaseRow } from "@/lib/db";
import { db } from "@/lib/db";
import { getMemberSession } from "@/lib/session";
import { trustedAppOrigins } from "@/lib/app-origins";
import { emptySummary, isFoodDate, nextFoodDate, parseFood, type FoodEntry, type FoodSummary } from "@/lib/food";

export const runtime = "nodejs";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const unavailable = () => response({ message: "We couldn’t reach your food journal. Please try again." }, 503);

export async function GET(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return response({ message: "Sign in to view your food journal." }, 401);
  const date = new URL(request.url).searchParams.get("date");
  if (!isFoodDate(date)) return response({ message: "Choose a valid date." }, 400);
  const monthStart = date.slice(0, 7) + "-01";
  const nextMonth = new Date(monthStart + "T00:00:00Z");
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  try {
    const [entriesResult, totalsResult, goalsResult] = await Promise.all([
      db.execute<DatabaseRow[]>(
        "SELECT id, name, calories, protein, carbs, fat, meal, category, \"analysisId\", \"chatMessageId\", to_char(\"eatenAtLocal\", 'YYYY-MM-DD\"T\"HH24:MI') AS \"eatenAtLocal\", \"timeZone\" FROM \"foodEntry\" WHERE \"userId\" = $1 AND \"eatenAtLocal\" >= $2 AND \"eatenAtLocal\" < $3 ORDER BY \"eatenAtLocal\" DESC, \"createdAt\" DESC, id DESC LIMIT 200",
        [session.user.id, date, nextFoodDate(date)],
      ),
      db.execute<DatabaseRow[]>(
        "SELECT to_char(\"eatenAtLocal\", 'YYYY-MM-DD') AS date, COUNT(*)::integer AS entries, SUM(calories) AS calories, SUM(protein) AS protein, SUM(carbs) AS carbs, SUM(fat) AS fat, SUM(CASE WHEN category = 'unhealthy' THEN 1 ELSE 0 END)::integer AS \"unhealthyEntries\", SUM(CASE WHEN category = 'unhealthy' THEN calories ELSE 0 END) AS \"unhealthyCalories\" FROM \"foodEntry\" WHERE \"userId\" = $1 AND \"eatenAtLocal\" >= $2 AND \"eatenAtLocal\" < $3 GROUP BY to_char(\"eatenAtLocal\", 'YYYY-MM-DD')",
        [session.user.id, monthStart, nextMonth.toISOString().slice(0, 10)],
      ),
      db.execute<DatabaseRow[]>('SELECT targets, to_char("effectiveFrom", \'YYYY-MM-DD\') AS "effectiveFrom" FROM "foodGoalVersion" WHERE "userId" = $1 AND "effectiveFrom" <= $2::date ORDER BY "effectiveFrom" DESC LIMIT 1', [session.user.id, date]),
    ]);
    const day = emptySummary(), month = emptySummary();
    for (const row of totalsResult[0]) {
      for (const key of Object.keys(month) as (keyof FoodSummary)[]) {
        const number = Number(row[key] || 0);
        month[key] = Math.round((month[key] + number) * 100) / 100;
        if (row.date === date) day[key] = number;
      }
    }
    const entries = entriesResult[0].map(row => ({
      ...row, calories: Number(row.calories), protein: Number(row.protein), carbs: Number(row.carbs), fat: Number(row.fat),
    })) as FoodEntry[];
    return response({ entries, day, month, goals: goalsResult[0][0]?.targets ?? null, goalEffectiveFrom: goalsResult[0][0]?.effectiveFrom ?? null });
  } catch { return unavailable(); }
}

async function mutate(request: Request, method: "POST" | "PATCH" | "DELETE") {
  const session = await getMemberSession(request);
  if (!session) return response({ message: "Sign in to change your food journal." }, 401);
  if (session.readOnly) return response({ message: "Viewing as a user is read-only." }, 403);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return response({ message: "This request is not allowed." }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return response({ message: "Send food details as JSON." }, 415);
  if (Number(request.headers.get("content-length")) > 8192) return response({ message: "This entry is too large." }, 413);
  let data: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 8192) return response({ message: "This entry is too large." }, 413);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    data = parsed as Record<string, unknown>;
  } catch { return response({ message: "Check your food details and try again." }, 400); }
  const entryId = typeof data.id === "string" ? data.id : "";
  if (method !== "POST" && !/^[a-f0-9-]{36}$/i.test(entryId)) return response({ message: "Choose a valid food entry." }, 400);
  if (method === "PATCH") {
    try {
      const [rows] = await db.execute<DatabaseRow[]>(
        "SELECT name, calories, protein, carbs, fat, meal, category, \"analysisId\", \"chatMessageId\", to_char(\"eatenAtLocal\", 'YYYY-MM-DD\"T\"HH24:MI') AS \"eatenAtLocal\", \"timeZone\" FROM \"foodEntry\" WHERE id = $1 AND \"userId\" = $2",
        [entryId, session.user.id],
      );
      if (!rows.length) return response({ message: "That food entry wasn’t found." }, 404);
      const stored = rows[0];
      data = { ...stored, calories: Number(stored.calories), protein: Number(stored.protein), carbs: Number(stored.carbs), fat: Number(stored.fat), ...data };
    } catch { return unavailable(); }
  }
  let food;
  if (method !== "DELETE") {
    try { food = parseFood(data); }
    catch (error) { return response({ message: error instanceof Error ? error.message : "Check your food details." }, 400); }
  }
  let analysisId: string | null = null;
  if (method !== "DELETE" && data.analysisId != null && data.analysisId !== "") {
    if (typeof data.analysisId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.analysisId)) return response({ message: "Choose a valid photo estimate." }, 400);
    try {
      const [analysis] = await db.execute<DatabaseRow[]>("SELECT id FROM \"foodAiUsage\" WHERE id = $1 AND \"userId\" = $2 AND status = 'succeeded'", [data.analysisId, session.user.id]);
      if (!analysis.length) return response({ message: "That photo estimate isn’t available for this account." }, 400);
      analysisId = data.analysisId;
    } catch { return unavailable(); }
  }
  try {
    if (method === "DELETE") {
      const [result] = await db.execute<DatabaseChange>("DELETE FROM \"foodEntry\" WHERE id = $1 AND \"userId\" = $2", [entryId, session.user.id]);
      return result.affectedRows ? response({ deleted: true }) : response({ message: "That food entry wasn’t found." }, 404);
    }
    const values = [food!.name, food!.calories, food!.protein, food!.carbs, food!.fat, food!.meal, food!.category, food!.eatenAtLocal.replace("T", " ") + ":00", food!.timeZone, analysisId];
    if (method === "PATCH") {
      const [result] = await db.execute<DatabaseChange>("UPDATE \"foodEntry\" SET name = $1, calories = $2, protein = $3, carbs = $4, fat = $5, meal = $6, category = $7, \"eatenAtLocal\" = $8, \"timeZone\" = $9, \"analysisId\" = $10 WHERE id = $11 AND \"userId\" = $12", [...values, entryId, session.user.id]);
      return result.affectedRows ? response({ id: entryId }) : response({ message: "That food entry wasn’t found." }, 404);
    }
    const id = randomUUID();
    await db.execute("INSERT INTO \"foodEntry\" (id, \"userId\", name, calories, protein, carbs, fat, meal, category, \"eatenAtLocal\", \"timeZone\", \"analysisId\") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)", [id, session.user.id, ...values]);
    return response({ id }, 201);
  } catch { return unavailable(); }
}

export const POST = (request: Request) => mutate(request, "POST");
export const PATCH = (request: Request) => mutate(request, "PATCH");
export const DELETE = (request: Request) => mutate(request, "DELETE");
