import { getSession } from "@/lib/session";
import { trustedAppOrigins } from "@/lib/app-origins";
import { CreditError, getCreditDefaults, saveCreditDefaults } from "@/lib/credits";

export const runtime = "nodejs";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) => error instanceof CreditError ? json({ message: error.message }, error.status) : json({ message: "We couldn’t load or save the defaults. Please try again." }, 503);
export async function GET() {
  const session = await getSession();
  if (!session) return json({ message: "Sign in to continue." }, 401);
  if (session.user.role !== "admin") return json({ message: "Administrator access required." }, 403);
  try { return json(await getCreditDefaults()); } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return json({ message: "Sign in to continue." }, 401);
  if (session.user.role !== "admin") return json({ message: "Administrator access required." }, 403);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return json({ message: "This request is not allowed." }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ message: "Send defaults as JSON." }, 415);
  if (Number(request.headers.get("content-length")) > 1024) return json({ message: "These details are too large." }, 413);
  let input: unknown;
  try {
    const text = await request.text();
    if (text.length > 1024) return json({ message: "These details are too large." }, 413);
    input = JSON.parse(text);
  } catch { return json({ message: "Check the new account defaults." }, 400); }
  try { return json(await saveCreditDefaults(session.user.id, input)); } catch (error) { return failure(error); }
}
