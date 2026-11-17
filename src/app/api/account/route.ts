import { getSession } from "@/lib/session";
import { db, type DatabaseRow } from "@/lib/db";
import { trustedAppOrigins } from "@/lib/app-origins";
import { parseProfile, type UserProfile } from "@/lib/profile";

export const runtime = "nodejs";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const unavailable = () => response({ message: "We couldn’t reach your profile. Please try again." }, 503);
const selectProfile = `SELECT u.id, u.name, u.email, u.role, to_char(p."dateOfBirth", 'YYYY-MM-DD') AS "dateOfBirth", p.sex, p."avatarId"
  FROM "user" u LEFT JOIN "userProfile" p ON p."userId" = u.id WHERE u.id = $1`;

export async function GET() {
  const session = await getSession();
  if (!session) return response({ message: "Sign in to continue." }, 401);
  try {
    const [rows] = await db.execute<DatabaseRow[]>(selectProfile, [session.user.id]);
    return rows.length ? response({ user: rows[0] as UserProfile }) : response({ message: "Sign in to continue." }, 401);
  } catch { return unavailable(); }
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return response({ message: "Sign in to update your profile." }, 401);
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
      const [rows] = await connection.execute<DatabaseRow[]>(selectProfile + " FOR UPDATE OF u", [session.user.id]);
      if (!rows.length) { await connection.rollback(); return response({ message: "Sign in to continue." }, 401); }
      let profile;
      try { profile = parseProfile(data, rows[0] as UserProfile); }
      catch (error) { await connection.rollback(); return response({ message: error instanceof Error ? error.message : "Check your profile details." }, 400); }
      await connection.execute('UPDATE "user" SET name = $1, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\') WHERE id = $2', [profile.name, session.user.id]);
      await connection.execute('INSERT INTO "userProfile" ("userId", "dateOfBirth", sex, "avatarId") VALUES ($1, $2::date, $3, $4) ON CONFLICT ("userId") DO UPDATE SET "dateOfBirth" = EXCLUDED."dateOfBirth", sex = EXCLUDED.sex, "avatarId" = EXCLUDED."avatarId", "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\')', [session.user.id, profile.dateOfBirth, profile.sex, profile.avatarId]);
      await connection.commit();
      return response({ user: { ...rows[0], ...profile } });
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  } catch { return unavailable(); }
}
