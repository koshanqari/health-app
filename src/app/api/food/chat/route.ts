import { getMemberSession } from "@/lib/session";
import { trustedAppOrigins } from "@/lib/app-origins";
import { confirmFoodChatProfile, confirmFoodChatGoals, confirmFoodChat, getFoodChat, sendFoodChat, resetFoodChat } from "@/lib/food-chat";
import { FoodAiError, readLimitedBody } from "@/lib/food-ai";

import { MAX_CHAT_PHOTOS, MAX_CHAT_PHOTO_BYTES, photoModes, type FoodChatPhotoMode } from "@/lib/food";

export const runtime = "nodejs";
export const maxDuration = 30;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  if (error instanceof FoodAiError) return json({ message: error.message, code: error.code }, error.status);
  console.error("Food chat failed. Check database and server configuration.");
  return json({ message: "Kay is unavailable right now. You can still log food in the journal." }, 503);
}
export async function GET(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return json({ message: "Sign in to chat with Kay." }, 401);
  const cursor = new URL(request.url).searchParams.get("before");
  if (cursor !== null && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) < 1)) return json({ message: "Choose a valid conversation page." }, 400);
  try { return json(await getFoodChat(session.user.id, {}, cursor === null ? undefined : Number(cursor), session.readOnly)); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return json({ message: "Sign in to chat with Kay." }, 401);
  if (session.readOnly) return json({ message: "Viewing as a user is read-only." }, 403);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return json({ message: "This request is not allowed." }, 403);
  try {
    if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) return json({ message: "Send a message or photo." }, 415);
    const bytes = await readLimitedBody(request, MAX_CHAT_PHOTO_BYTES + 16_384);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("content-type")! } }).formData(); }
    catch { return json({ message: "Check your message and photo." }, 400); }
    const text = form.get("text") ?? "", photos = [...form.getAll("photos"), ...form.getAll("photo")], photoMode = form.get("photoMode") ?? "auto", requestId = form.get("requestId"), version = form.get("version"), timeZone = form.get("timeZone");
    if (typeof text !== "string" || typeof requestId !== "string" || typeof timeZone !== "string" || typeof version !== "string" || !/^\d+$/.test(version) || typeof photoMode !== "string" || !photoModes.includes(photoMode as FoodChatPhotoMode) || photos.some(photo => !(photo instanceof File) || !["image/jpeg", "image/png", "image/webp"].includes(photo.type))) return json({ message: "Check your message and photo." }, 400);
    if (photos.length > MAX_CHAT_PHOTOS) return json({ message: `Attach up to ${MAX_CHAT_PHOTOS} photos per message.`, code: "CHAT_PHOTOS" }, 400);
    return json(await sendFoodChat(session.user.id, { text, requestId, version: Number(version), timeZone, photoMode: photoMode as FoodChatPhotoMode, photos: await Promise.all((photos as File[]).map(async photo => new Uint8Array(await photo.arrayBuffer()))) }, { signal: request.signal }));
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return json({ message: "Sign in to log food." }, 401);
  if (session.readOnly) return json({ message: "Viewing as a user is read-only." }, 403);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return json({ message: "This request is not allowed." }, 403);
  try {
    if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ message: "Send food details as JSON." }, 415);
    let body;
    try { body = JSON.parse((await readLimitedBody(request, 8192)).toString("utf8")); }
    catch (error) { if (error instanceof FoodAiError) throw error; return json({ message: "Check the food details." }, 400); }
    if (body?.profile !== undefined) return json(await confirmFoodChatProfile(session.user.id, body?.draftId, body.profile));
    return json(body?.goals !== undefined ? await confirmFoodChatGoals(session.user.id, body?.draftId, body.goals) : await confirmFoodChat(session.user.id, body?.draftId, body?.food));
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return json({ message: "Sign in to start a new chat." }, 401);
  if (session.readOnly) return json({ message: "Viewing as a user is read-only." }, 403);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return json({ message: "This request is not allowed." }, 403);
  try { return json(await resetFoodChat(session.user.id)); }
  catch (error) { return failure(error); }
}
