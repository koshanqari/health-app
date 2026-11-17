import { getSession } from "@/lib/session";
import { trustedAppOrigins } from "@/lib/app-origins";
import { analyzeFoodPhoto, FoodAiError, foodAiSettings, foodAiStatus, MAX_PHOTO_BYTES } from "@/lib/food-ai";

export const runtime = "nodejs";
export const maxDuration = 30;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
function errorResponse(error: unknown) {
  if (error instanceof FoodAiError) return json({ message: error.message, code: error.code }, error.status);
  console.error("Food photo analysis failed. Check the database and server configuration.");
  return json({ message: "Photo analysis is unavailable. You can still log food manually." }, 503);
}

export async function GET() {
  const session = await getSession();
  if (!session) return json({ message: "Sign in to use photo analysis." }, 401);
  try { return json(await foodAiStatus(session.user.id)); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return json({ message: "Sign in to use photo analysis." }, 401);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return json({ message: "This request is not allowed." }, 403);
  try {
    if (!foodAiSettings().apiKey) throw new FoodAiError(503, "AI_NOT_CONFIGURED", "Photo analysis isn’t connected yet. You can still log food manually.");
    if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) return json({ message: "Choose a food photo." }, 415);
    const limit = MAX_PHOTO_BYTES + 16_384;
    if (Number(request.headers.get("content-length")) > limit) return json({ message: "This photo is too large." }, 413);
    const reader = request.body?.getReader();
    if (!reader) return json({ message: "Choose a food photo." }, 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); return json({ message: "This photo is too large." }, 413); }
      chunks.push(value);
    }
    let form: FormData;
    try { form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": request.headers.get("content-type")! } }).formData(); }
    catch { return json({ message: "Choose a valid food photo." }, 400); }
    const photo = form.get("photo"), note = form.get("note") ?? "";
    if (!(photo instanceof File) || !["image/jpeg", "image/png", "image/webp"].includes(photo.type) || typeof note !== "string") return json({ message: "Choose a JPEG, PNG, or WebP photo." }, 400);
    return json(await analyzeFoodPhoto(session.user.id, new Uint8Array(await photo.arrayBuffer()), note, { signal: request.signal }));
  } catch (error) { return errorResponse(error); }
}
