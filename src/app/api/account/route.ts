import { getMemberSession } from "@/lib/session";
import { db } from "@/lib/db";
import { trustedAppOrigins } from "@/lib/app-origins";
import { readProfile, saveProfileChange, ProfileUpdateError } from "@/lib/profile-store";

export const runtime = "nodejs";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const unavailable = () => response({ message: "We couldn’t reach your profile. Please try again." }, 503);


export async function GET(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return response({ message: "Sign in to continue." }, 401);
  try {
    const user = await readProfile(db, session.user.id);
    return user ? response({ user }) : response({ message: "Sign in to continue." }, 401);
  } catch (error) { return error instanceof ProfileUpdateError ? response({ message: error.message }, error.status) : unavailable(); }
}

export async function PATCH(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return response({ message: "Sign in to update your profile." }, 401);
  if (session.readOnly) return response({ message: "Viewing as a user is read-only." }, 403);
  if (!trustedAppOrigins.includes(request.headers.get("origin") ?? "")) return response({ message: "This request is not allowed." }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return response({ message: "Send profile details as JSON." }, 415);
  if (Number(request.headers.get("content-length")) > 4096) return response({ message: "These profile details are too large." }, 413);
  let data: unknown;
  try {
    const text = await request.text();
    if (text.length > 4096) return response({ message: "These profile details are too large." }, 413);
    data = JSON.parse(text);
  } catch { return response({ message: "Check your profile details." }, 400); }
  try {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const user = await saveProfileChange(connection, session.user.id, data);
      await connection.commit();
      return response({ user });
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  } catch (error) { return error instanceof ProfileUpdateError ? response({ message: error.message }, error.status) : unavailable(); }
}
