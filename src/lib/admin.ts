import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { db, type DatabaseConnection, type DatabaseRow } from "./db";
import { parseProfile } from "./profile";

type Store = Pick<typeof db, "getConnection">;
export class AdminError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const record = (value: unknown, keys: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new AdminError(400, "Check the account details.");
  return value as Record<string, unknown>;
};
function credentials(value: unknown) {
  const data = record(value, ["name", "email", "password"]);
  let name: string;
  try { name = parseProfile({ name: data.name }).name; }
  catch { throw new AdminError(400, "Enter a name between 1 and 80 characters."); }
  if (typeof data.email !== "string" || data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) throw new AdminError(400, "Enter a valid email address.");
  if (typeof data.password !== "string" || data.password.length < 12 || data.password.length > 128) throw new AdminError(400, "Use a password between 12 and 128 characters.");
  return { name, email: data.email.trim().toLowerCase(), password: data.password };
}
async function locked<T>(store: Store, work: (connection: DatabaseConnection) => Promise<T>) {
  const connection = await store.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("SELECT pg_advisory_xact_lock(1835462105)");
    const result = await work(connection);
    await connection.commit(); return result;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
async function requireActor(connection: DatabaseConnection, actorId: string) {
  const [rows] = await connection.execute<DatabaseRow[]>('SELECT role FROM "user" WHERE id = $1', [actorId]);
  if (rows[0]?.role !== "admin") throw new AdminError(403, "Administrator access required.");
}
async function insertAdmin(connection: DatabaseConnection, input: ReturnType<typeof credentials>) {
  const [existing] = await connection.execute<DatabaseRow[]>('SELECT id FROM "user" WHERE lower(email) = $1', [input.email]);
  if (existing.length) throw new AdminError(409, "This email already has an account. Change its role in the directory instead.");
  const id = randomUUID(), password = await hashPassword(input.password);
  await connection.execute(`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
    VALUES ($1, $2, $3, FALSE, 'admin', CURRENT_TIMESTAMP AT TIME ZONE 'UTC', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`, [id, input.name, input.email]);
  await connection.execute(`INSERT INTO "account" (id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt")
    VALUES ($1, $2, $2, 'credential', $3, CURRENT_TIMESTAMP AT TIME ZONE 'UTC', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`, [randomUUID(), id, password]);
  return { id, name: input.name, email: input.email, role: "admin" };
}
export async function bootstrapAdmin(env: Record<string, string | undefined>, store: Store = db) {
  if (!env.BOOT_ADMIN_USER?.trim()) return "unconfigured" as const;
  const email = env.BOOT_ADMIN_USER.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AdminError(400, "BOOT_ADMIN_USER must be an existing account’s email address.");
  return locked(store, async connection => {
    const [users] = await connection.execute<DatabaseRow[]>('SELECT id, role FROM "user" WHERE lower(email) = $1 FOR UPDATE', [email]);
    if (!users.length) throw new AdminError(404, "The bootstrap account does not exist. Sign up normally with the BOOT_ADMIN_USER email first.");
    if (users[0].role === "admin") return "exists" as const;
    await connection.execute(`UPDATE "user" SET role = 'admin', "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE id = $1`, [users[0].id]);
    await connection.execute('DELETE FROM "session" WHERE "userId" = $1', [users[0].id]);
    return "promoted" as const;
  });
}
export async function createAdmin(actorId: string, value: unknown, store: Store = db) {
  const input = credentials(value);
  return locked(store, async connection => { await requireActor(connection, actorId); return insertAdmin(connection, input); });
}
export async function changeUserRole(actorId: string, value: unknown, store: Store = db) {
  const data = record(value, ["id", "role"]);
  if (typeof data.id !== "string" || !data.id || data.id.length > 128 || (typeof data.role !== "string" || !["user", "admin"].includes(data.role))) throw new AdminError(400, "Choose an account and a valid role.");
  return locked(store, async connection => {
    await requireActor(connection, actorId);
    const [users] = await connection.execute<DatabaseRow[]>('SELECT id, role FROM "user" WHERE id = $1 FOR UPDATE', [data.id]);
    if (!users.length) throw new AdminError(404, "That account was not found.");
    if (users[0].role === data.role) return;
    if (users[0].role === "admin") {
      const [counts] = await connection.execute<DatabaseRow[]>('SELECT COUNT(*)::integer AS total FROM "user" WHERE role = \'admin\'');
      if (counts[0].total <= 1) throw new AdminError(409, "Keep at least one administrator. Add another administrator first.");
    }
    await connection.execute('UPDATE "user" SET role = $1, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\') WHERE id = $2', [data.role, data.id]);
    await connection.execute('DELETE FROM "session" WHERE "userId" = $1', [data.id]);
  });
}
