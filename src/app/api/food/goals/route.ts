import { db } from "@/lib/db";
import { getMemberSession } from "@/lib/session";
import { trustedAppOrigins } from "@/lib/app-origins";
import { parseFoodGoalChange } from "@/lib/food-goals";

import { saveFoodGoalChange } from "@/lib/food-goal-store";

export const runtime = "nodejs";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function PUT(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return response({ message: "Sign in to set your goals." }, 401);
  if (session.readOnly) return response({ message: "Viewing as a user is read-only." }, 403);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return response({ message: "This request is not allowed." }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return response({ message: "Send goals as JSON." }, 415);
  if (Number(request.headers.get("content-length")) > 4096) return response({ message: "These goals are too large." }, 413);
  let change;
  try {
    const text = await request.text();
    if (text.length > 4096) return response({ message: "These goals are too large." }, 413);
    change = parseFoodGoalChange(JSON.parse(text));
  } catch (error) { return response({ message: error instanceof SyntaxError ? "Check your goal ranges." : error instanceof Error ? error.message : "Check your goal ranges." }, 400); }
  try {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await saveFoodGoalChange(connection, session.user.id, change);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return response({ goals: change.goals, effectiveFrom: change.effectiveFrom });
  } catch { return response({ message: "We couldn’t save your goals. Please try again." }, 503); }
}
