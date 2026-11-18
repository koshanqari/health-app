import { createHash } from "node:crypto";
import { db, type DatabaseConnection, type DatabaseRow } from "./db";
import { readProfile } from "./profile-store";
import { nextFoodDate } from "./food";
import { foodHistoryWindow, type HistoryPeriod } from "./food-history";
import { parseActivityFacts, resolveActivity, type ActivityEntry, type ActivityInput, type ActivityJournalData, type ActivityDay, type ActivityGoalVersion, type ActivityHistoryData } from "./activity";

export class ActivityError extends Error { constructor(public status: number, message: string) { super(message); } }
export const validActivityId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
export async function migrateActivity(connection: DatabaseConnection) {
  await connection.execute(`CREATE TABLE IF NOT EXISTS "activityEntry" (
    id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    data JSONB NOT NULL CHECK (jsonb_typeof(data) = 'object'),
    "occurredAtLocal" TIMESTAMP NOT NULL,
    calories NUMERIC GENERATED ALWAYS AS ((data->>'calories')::numeric) STORED CHECK (calories >= 0),
    minutes NUMERIC GENERATED ALWAYS AS ((data->>'durationMinutes')::numeric) STORED CHECK (minutes > 0 AND minutes <= 1440),
    steps INTEGER GENERATED ALWAYS AS ((data->>'steps')::integer) STORED CHECK (steps >= 0 AND steps <= 200000),
    fingerprint TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    "chatMessageId" TEXT REFERENCES "foodChatMessage"(id) ON DELETE SET NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))`);
  await connection.execute(`CREATE UNIQUE INDEX IF NOT EXISTS activity_daily_steps ON "activityEntry" ("userId", ("occurredAtLocal"::date)) WHERE data->>'stepScope'='daily_total'`);
  await connection.execute('CREATE INDEX IF NOT EXISTS activity_owner_date ON "activityEntry" ("userId", "occurredAtLocal")');
  await connection.execute(`CREATE TABLE IF NOT EXISTS "activityGoalVersion" (
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "effectiveFrom" DATE NOT NULL CHECK ("effectiveFrom" BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
    targets JSONB NOT NULL CHECK (jsonb_typeof(targets) = 'object'),
    PRIMARY KEY ("userId", "effectiveFrom"))`);
}
const entry = (row: DatabaseRow): ActivityEntry => ({ ...row.data, id: row.id, revision: Number(row.revision), chatMessageId: row.chatMessageId ?? null });
export async function activityTransaction<T>(work: (connection: DatabaseConnection) => Promise<T>) {
  const connection = await db.getConnection();
  try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; }
  catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}
export async function saveActivity(connection: DatabaseConnection, userId: string, id: string, value: unknown, revision?: number, reviewed?: ActivityInput, chatMessageId?: string) {
  // Serialise retries for the same id, including concurrent first inserts.
  await connection.execute('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
  const [rows] = await connection.execute<DatabaseRow[]>('SELECT * FROM "activityEntry" WHERE id = $1 FOR UPDATE', [id]);
  const existing = rows[0];
  if (existing && existing.userId !== userId) throw new ActivityError(404, "That activity wasn’t found.");
  const facts = parseActivityFacts(value);
  const fingerprint = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  if (revision === undefined && existing) {
    if (existing.fingerprint !== fingerprint) throw new ActivityError(409, "Use a new request for changed activity details.");
    return entry(existing);
  }
  if (revision !== undefined && !existing) throw new ActivityError(404, "That activity wasn’t found.");
  if (existing && Number(existing.revision) !== revision) throw new ActivityError(409, "This activity changed. Reopen it before editing.");
  const profile = await readProfile(connection, userId);
  const activity = resolveActivity(facts, { weightKg: profile?.weightKg ?? null, age: profile?.age ?? null }, existing?.data ?? reviewed);
  if (existing) await connection.execute(`UPDATE "activityEntry" SET data=$1, "occurredAtLocal"=$2, fingerprint=$3, revision=revision+1, "updatedAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE id=$4 AND "userId"=$5`, [JSON.stringify(activity), activity.occurredAtLocal, fingerprint, id, userId]);
  else await connection.execute('INSERT INTO "activityEntry" (id, "userId", data, "occurredAtLocal", fingerprint, "chatMessageId") VALUES ($1,$2,$3,$4,$5,$6)', [id, userId, JSON.stringify(activity), activity.occurredAtLocal, fingerprint, chatMessageId ?? null]);
  return { ...activity, id, revision: existing ? Number(existing.revision) + 1 : 1, chatMessageId: existing?.chatMessageId ?? chatMessageId ?? null } as ActivityEntry;
}
export async function deleteActivity(connection: DatabaseConnection, userId: string, id: string, revision: number) {
  const [rows] = await connection.execute<DatabaseRow[]>('SELECT revision FROM "activityEntry" WHERE id=$1 AND "userId"=$2 FOR UPDATE', [id, userId]);
  if (!rows.length) throw new ActivityError(404, "That activity wasn’t found.");
  if (Number(rows[0].revision) !== revision) throw new ActivityError(409, "This activity changed. Reopen it before deleting.");
  await connection.execute('DELETE FROM "activityEntry" WHERE id=$1 AND "userId"=$2', [id, userId]);
}
async function dailyTotals(userId: string, start: string, end: string): Promise<ActivityDay[]> {
  const [rows] = await db.execute<DatabaseRow[]>(`SELECT to_char("occurredAtLocal", 'YYYY-MM-DD') AS date, COUNT(*)::int AS entries, SUM(calories) AS calories, SUM(minutes) AS minutes, GREATEST(COALESCE(SUM(steps) FILTER (WHERE COALESCE(data->>'stepScope','session')='session'),0), COALESCE(MAX(steps) FILTER (WHERE data->>'stepScope'='daily_total'),0)) AS steps FROM "activityEntry" WHERE "userId"=$1 AND "occurredAtLocal">=$2 AND "occurredAtLocal"<$3 GROUP BY 1`, [userId, start, nextFoodDate(end)]);
  return rows.map(row => ({ date: row.date, entries: Number(row.entries), calories: Number(row.calories || 0), steps: Number(row.steps || 0), minutes: Number(row.minutes || 0) }));
}
export async function getActivityJournal(userId: string, date: string): Promise<ActivityJournalData> {
  const [[rows], days, [versions], profile] = await Promise.all([
    db.execute<DatabaseRow[]>('SELECT id, data, revision, "chatMessageId" FROM "activityEntry" WHERE "userId"=$1 AND "occurredAtLocal">=$2 AND "occurredAtLocal"<$3 ORDER BY "occurredAtLocal" DESC, "createdAt" DESC LIMIT 200', [userId, date, nextFoodDate(date)]),
    dailyTotals(userId, date, date),
    db.execute<DatabaseRow[]>(`SELECT targets, to_char("effectiveFrom", 'YYYY-MM-DD') AS date FROM "activityGoalVersion" WHERE "userId"=$1 AND "effectiveFrom"<=$2 ORDER BY "effectiveFrom" DESC LIMIT 1`, [userId, date]),
    readProfile(db, userId),
  ]);
  return { entries: rows.map(entry), day: days[0] ?? { date, entries: 0, calories: 0, steps: 0, minutes: 0 }, goals: versions[0]?.targets ?? null, goalEffectiveFrom: versions[0]?.date ?? null, profile: { weightKg: profile?.weightKg ?? null, age: profile?.age ?? null } };
}
export async function getActivityHistory(userId: string, period: HistoryPeriod, date: string): Promise<ActivityHistoryData> {
  const { start, end } = foodHistoryWindow(period, date);
  const [totals, [versions]] = await Promise.all([dailyTotals(userId, start, end), db.execute<DatabaseRow[]>(`SELECT targets AS goals, to_char("effectiveFrom", 'YYYY-MM-DD') AS "effectiveFrom" FROM "activityGoalVersion" WHERE "userId"=$1 AND "effectiveFrom"<=$3 AND ("effectiveFrom">=$2 OR "effectiveFrom"=(SELECT MAX("effectiveFrom") FROM "activityGoalVersion" WHERE "userId"=$1 AND "effectiveFrom"<$2)) ORDER BY "effectiveFrom"`, [userId, start, end])]);
  const byDate = new Map(totals.map(day => [day.date, day]));
  const days: ActivityDay[] = [];
  for (let d = start; d <= end; d = nextFoodDate(d)) days.push(byDate.get(d) ?? { date: d, entries: 0, calories: 0, steps: 0, minutes: 0 });
  return { start, end, days, goalVersions: versions as ActivityGoalVersion[] };
}
