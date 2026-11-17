import { db, type DatabaseRow } from "@/lib/db";
import { getSession } from "@/lib/session";
import { trustedAppOrigins } from "@/lib/app-origins";
import { parseFoodGoalChange } from "@/lib/food-goals";

export const runtime = "nodejs";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function PUT(request: Request) {
  const session = await getSession();
  if (!session) return response({ message: "Sign in to set your goals." }, 401);
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
      await connection.execute('SELECT pg_advisory_xact_lock(1835462104, hashtext($1))', [session.user.id]);
      await connection.execute('INSERT INTO "foodGoalVersion" ("userId", "effectiveFrom", targets) VALUES ($1, $2::date, $3::jsonb) ON CONFLICT ("userId", "effectiveFrom") DO UPDATE SET targets = EXCLUDED.targets, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\')', [session.user.id, change.effectiveFrom, JSON.stringify(change.goals)]);
      // Keep the legacy snapshot compatible during rollout; reads use dated versions.
      const [active] = await connection.execute<DatabaseRow[]>('SELECT targets FROM "foodGoalVersion" WHERE "userId" = $1 AND "effectiveFrom" <= $2::date ORDER BY "effectiveFrom" DESC LIMIT 1', [session.user.id, change.today]);
      if (active.length) await connection.execute('INSERT INTO "foodGoal" ("userId", targets) VALUES ($1, $2::jsonb) ON CONFLICT ("userId") DO UPDATE SET targets = EXCLUDED.targets, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\')', [session.user.id, JSON.stringify(active[0].targets)]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return response({ goals: change.goals, effectiveFrom: change.effectiveFrom });
  } catch { return response({ message: "We couldn’t save your goals. Please try again." }, 503); }
}
