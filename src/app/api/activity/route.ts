import { db } from "@/lib/db";
import { getMemberSession } from "@/lib/session";
import { trustedAppOrigins } from "@/lib/app-origins";
import { isFoodDate } from "@/lib/food";
import { historyPeriods, type HistoryPeriod } from "@/lib/food-history";
import { parseActivityGoals } from "@/lib/activity";
import { ActivityError, activityTransaction, deleteActivity, getActivityHistory, getActivityJournal, saveActivity, validActivityId } from "@/lib/activity-store";
export const runtime = "nodejs";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const unavailable = () => json({ message: "We couldn’t reach your activity journal. Please try again." }, 503);
export async function GET(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return json({ message: "Sign in to view activity." }, 401);
  const params = new URL(request.url).searchParams, date = params.get("date"), period = params.get("period");
  if (!isFoodDate(date) || (period !== null && !historyPeriods.includes(period as HistoryPeriod))) return json({ message: "Choose a valid date and period." }, 400);
  try { return json(period ? await getActivityHistory(session.user.id, period as HistoryPeriod, date) : await getActivityJournal(session.user.id, date)); } catch { return unavailable(); }
}
async function mutate(request: Request, method: "POST" | "PATCH" | "DELETE" | "PUT") {
  const session = await getMemberSession(request);
  if (!session) return json({ message: "Sign in to change activity." }, 401);
  if (session.readOnly) return json({ message: "Viewing as a user is read-only." }, 403);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return json({ message: "This request is not allowed." }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ message: "Send activity details as JSON." }, 415);
  if (Number(request.headers.get("content-length")) > 8192) return json({ message: "This entry is too large." }, 413);
  let body;
  try { const text = await request.text(); if (text.length > 8192) return json({ message: "This entry is too large." }, 413); body = JSON.parse(text); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(); } catch { return json({ message: "Check your activity details." }, 400); }
  try {
    if (method === "PUT") {
      if (!isFoodDate(body.effectiveFrom)) return json({ message: "Choose a valid goal start date." }, 400);
      const goals = parseActivityGoals(body.goals);
      await db.execute('INSERT INTO "activityGoalVersion" ("userId", "effectiveFrom", targets) VALUES ($1,$2,$3) ON CONFLICT ("userId", "effectiveFrom") DO UPDATE SET targets=EXCLUDED.targets', [session.user.id, body.effectiveFrom, JSON.stringify(goals)]);
      return json({ saved: true });
    }
    if (!validActivityId(body.id) || (method !== "POST" && (!Number.isSafeInteger(body.revision) || body.revision < 1))) return json({ message: "Choose a valid activity and revision." }, 400);
    if (method === "DELETE") { await activityTransaction(connection => deleteActivity(connection, session.user.id, body.id, body.revision)); return json({ deleted: true }); }
    const result = await activityTransaction(connection => saveActivity(connection, session.user.id, body.id, body.activity, method === "PATCH" ? body.revision : undefined));
    return json(result, method === "POST" ? 201 : 200);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") return json({ message: "A daily step total already exists for this date. Edit that entry to update it." }, 409);
    if (error instanceof ActivityError) return json({ message: error.message }, error.status);
    // Validators throw plain errors; database errors carry a code and are never exposed.
    if (error instanceof Error && !("code" in error)) return json({ message: error.message }, 400);
    return unavailable();
  }
}
export const POST = (request: Request) => mutate(request, "POST");
export const PATCH = (request: Request) => mutate(request, "PATCH");
export const DELETE = (request: Request) => mutate(request, "DELETE");
export const PUT = (request: Request) => mutate(request, "PUT");
