import { getSession } from "@/lib/session";
import { db } from "@/lib/db";
import type { DatabaseRow } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ message: "Sign in to continue." }, { status: 401 });
  if (session.user.role !== "admin") return Response.json({ message: "Administrator access required." }, { status: 403 });
  const [users] = await db.execute<DatabaseRow[]>(
    "SELECT id, name, email, role, \"createdAt\" FROM \"user\" ORDER BY \"createdAt\" DESC LIMIT 100",
  );
  return Response.json({ users }, { headers: { "Cache-Control": "no-store" } });
}
