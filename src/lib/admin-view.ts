import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db, type DatabaseConnection, type DatabaseRow } from "./db";
import { AdminError } from "./admin";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
export async function migrateAdminViews(connection: DatabaseConnection) {
  await connection.execute(`CREATE TABLE IF NOT EXISTS "adminView" (
    id TEXT PRIMARY KEY, "tokenHash" TEXT NOT NULL UNIQUE,
    "actorId" TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    "targetId" TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    "adminSessionId" TEXT NOT NULL,
    "startedAt" TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "expiresAt" TIMESTAMP NOT NULL, "endedAt" TIMESTAMP
  )`);
  await connection.execute('CREATE INDEX IF NOT EXISTS admin_view_session ON "adminView" ("adminSessionId") WHERE "endedAt" IS NULL');
}
export async function startAdminView(actorId: string, sessionId: string, targetId: unknown) {
  if (typeof targetId !== "string" || !targetId || targetId.length > 128) throw new AdminError(400, "Choose an account to view.");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sessionId]);
    const [actors] = await connection.execute<DatabaseRow[]>(`SELECT u.role FROM "user" u JOIN "session" s ON s."userId" = u.id
      WHERE u.id = $1 AND s.id = $2 AND s."expiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') FOR SHARE OF u, s`, [actorId, sessionId]);
    if (actors[0]?.role !== "admin") throw new AdminError(403, "Administrator access required.");
    const [targets] = await connection.execute<DatabaseRow[]>('SELECT id FROM "user" WHERE id = $1 FOR SHARE', [targetId]);
    if (!targets.length) throw new AdminError(404, "That account was not found.");
    const token = randomBytes(32).toString("hex");
    await connection.execute('UPDATE "adminView" SET "endedAt" = (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\') WHERE "actorId" = $1 AND "adminSessionId" = $2 AND "endedAt" IS NULL', [actorId, sessionId]);
    await connection.execute(`INSERT INTO "adminView" (id, "tokenHash", "actorId", "targetId", "adminSessionId", "expiresAt")
      VALUES ($1, $2, $3, $4, $5, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '30 minutes')`, [randomUUID(), digest(token), actorId, targetId, sessionId]);
    await connection.commit();
    return { url: "/app?view=" + token };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
export async function resolveAdminView(actorId: string, sessionId: string, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const [rows] = await db.execute<DatabaseRow[]>(`SELECT u.id, u.name, u.email, u.role, u."emailVerified", u.image, u."createdAt", u."updatedAt",
    to_char(v."expiresAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "viewExpiresAt"
    FROM "adminView" v JOIN "user" u ON u.id = v."targetId" JOIN "user" a ON a.id = v."actorId"
    WHERE v."tokenHash" = $1 AND v."actorId" = $2 AND v."adminSessionId" = $3 AND a.role = 'admin'
      AND v."endedAt" IS NULL AND v."expiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`, [digest(token), actorId, sessionId]);
  return rows[0] ?? null;
}
export async function endAdminView(actorId: string, sessionId: string, token: unknown) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new AdminError(400, "Choose a valid viewing session.");
  await db.execute('UPDATE "adminView" SET "endedAt" = COALESCE("endedAt", CURRENT_TIMESTAMP AT TIME ZONE \'UTC\') WHERE "tokenHash" = $1 AND "actorId" = $2 AND "adminSessionId" = $3', [digest(token), actorId, sessionId]);
}
