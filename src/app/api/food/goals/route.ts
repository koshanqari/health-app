import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { trustedAppOrigins } from "@/lib/app-origins";
import { parseFoodGoals } from "@/lib/food-goals";

export const runtime = "nodejs";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function PUT(request: Request) {
  const session = await getSession();
  if (!session) return response({ message: "Sign in to set your goals." }, 401);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return response({ message: "This request is not allowed." }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return response({ message: "Send goals as JSON." }, 415);
  if (Number(request.headers.get("content-length")) > 4096) return response({ message: "These goals are too large." }, 413);
  let goals;
  try {
    const text = await request.text();
    if (text.length > 4096) return response({ message: "These goals are too large." }, 413);
    goals = parseFoodGoals(JSON.parse(text));
  } catch (error) { return response({ message: error instanceof SyntaxError ? "Check your goal ranges." : error instanceof Error ? error.message : "Check your goal ranges." }, 400); }
  try {
    await db.execute('INSERT INTO "foodGoal" ("userId", targets) VALUES ($1, $2::jsonb) ON CONFLICT ("userId") DO UPDATE SET targets = EXCLUDED.targets, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\')', [session.user.id, JSON.stringify(goals)]);
    return response({ goals });
  } catch { return response({ message: "We couldn’t save your goals. Please try again." }, 503); }
}
