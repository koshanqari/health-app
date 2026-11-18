import { getMemberSession } from "@/lib/session";
import { trustedAppOrigins } from "@/lib/app-origins";
import { administerCredits, CreditError, getCreditDetails, publicCreditDetails } from "@/lib/credits";

export const runtime = "nodejs";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) => error instanceof CreditError ? json({ message: error.message, code: error.code }, error.status) : json({ message: "Credits are unavailable right now. Please try again." }, 503);
export async function GET(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return json({ message: "Sign in to view credits." }, 401);
  const userId = new URL(request.url).searchParams.get("userId") || session.user.id;
  if (userId !== session.user.id && (session.readOnly || session.user.role !== "admin")) return json({ message: "Administrator access required." }, 403);
  const adminView = !session.readOnly && session.user.role === "admin" && new URL(request.url).searchParams.has("userId");
  try { const data = await getCreditDetails(userId, adminView ? true : "additions", session.readOnly); return json(adminView ? data : publicCreditDetails(data)); } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return json({ message: "Sign in to continue." }, 401);
  if (session.readOnly) return json({ message: "Viewing as a user is read-only." }, 403);
  if (session.user.role !== "admin") return json({ message: "Administrator access required." }, 403);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return json({ message: "This request is not allowed." }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ message: "Send credit details as JSON." }, 415);
  if (Number(request.headers.get("content-length")) > 4096) return json({ message: "These details are too large." }, 413);
  let input: unknown;
  try {
    const text = await request.text();
    if (text.length > 4096) return json({ message: "These details are too large." }, 413);
    input = JSON.parse(text);
  } catch { return json({ message: "Check the credit details." }, 400); }
  try { await administerCredits(session.user.id, input); return json({ message: "Credit account updated." }); }
  catch (error) { return failure(error); }
}
