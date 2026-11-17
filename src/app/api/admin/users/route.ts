import { getSession } from "@/lib/session";
import { db, type DatabaseRow } from "@/lib/db";
import { trustedAppOrigins } from "@/lib/app-origins";
import { AdminError, createAdmin, changeUserRole } from "@/lib/admin";

export const runtime = "nodejs";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export async function GET() {
  const session = await getSession();
  if (!session) return json({ message: "Sign in to continue." }, 401);
  if (session.user.role !== "admin") return json({ message: "Administrator access required." }, 403);
  try {
    const [users] = await db.execute<DatabaseRow[]>('SELECT id, name, email, role, "createdAt" FROM "user" ORDER BY "createdAt" DESC LIMIT 100');
    return json({ users });
  } catch { return json({ message: "We couldn’t load accounts. Please try again." }, 503); }
}
async function mutate(request: Request, action: "create" | "role") {
  const session = await getSession();
  if (!session) return json({ message: "Sign in to continue." }, 401);
  if (session.user.role !== "admin") return json({ message: "Administrator access required." }, 403);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return json({ message: "This request is not allowed." }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ message: "Send account details as JSON." }, 415);
  if (Number(request.headers.get("content-length")) > 4096) return json({ message: "These account details are too large." }, 413);
  let input: unknown;
  try {
    const text = await request.text();
    if (text.length > 4096) return json({ message: "These account details are too large." }, 413);
    input = JSON.parse(text);
  } catch { return json({ message: "Check the account details." }, 400); }
  try {
    if (action === "create") return json({ user: await createAdmin(session.user.id, input) }, 201);
    await changeUserRole(session.user.id, input);
    return json({ message: "Role updated. The account must sign in again." });
  } catch (error) {
    if (error instanceof AdminError) return json({ message: error.message }, error.status);
    if (error && typeof error === "object" && "code" in error && error.code === "23505") return json({ message: "This email already has an account." }, 409);
    return json({ message: "We couldn’t update this account. Please try again." }, 503);
  }
}
export const POST = (request: Request) => mutate(request, "create");
export const PATCH = (request: Request) => mutate(request, "role");
