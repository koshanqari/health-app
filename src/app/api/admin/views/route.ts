import { getSession } from "@/lib/session";
import { trustedAppOrigins } from "@/lib/app-origins";
import { startAdminView, endAdminView } from "@/lib/admin-view";
import { AdminError } from "@/lib/admin";

export const runtime = "nodejs";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function mutate(request: Request, stop: boolean) {
  const session = await getSession();
  if (!session) return json({ message: "Sign in to continue." }, 401);
  if (session.user.role !== "admin") return json({ message: "Administrator access required." }, 403);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return json({ message: "This request is not allowed." }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ message: "Send viewing details as JSON." }, 415);
  if (Number(request.headers.get("content-length")) > 1024) return json({ message: "These details are too large." }, 413);
  let data: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 1024) return json({ message: "These details are too large." }, 413);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some(key => key !== (stop ? "token" : "userId"))) throw new Error();
    data = parsed;
  } catch { return json({ message: "Check the viewing details." }, 400); }
  try {
    if (stop) { await endAdminView(session.user.id, session.session.id, data.token); return json({ message: "Viewing session ended." }); }
    return json(await startAdminView(session.user.id, session.session.id, data.userId));
  } catch (error) { return error instanceof AdminError ? json({ message: error.message }, error.status) : json({ message: "We couldn’t open this account. Please try again." }, 503); }
}
export const POST = (request: Request) => mutate(request, false);
export const DELETE = (request: Request) => mutate(request, true);
