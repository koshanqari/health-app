import type { DatabaseConnection, DatabaseRow } from "./db";
import type { parseFoodGoalChange } from "./food-goals";

// The caller owns the transaction; serialize all manual and AI-confirmed goal writes.
export async function saveFoodGoalChange(connection: DatabaseConnection, userId: string, change: ReturnType<typeof parseFoodGoalChange>) {
  await connection.execute('SELECT pg_advisory_xact_lock(1835462104, hashtext($1))', [userId]);
  await connection.execute('INSERT INTO "foodGoalVersion" ("userId", "effectiveFrom", targets) VALUES ($1, $2::date, $3::jsonb) ON CONFLICT ("userId", "effectiveFrom") DO UPDATE SET targets = EXCLUDED.targets, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\')', [userId, change.effectiveFrom, JSON.stringify(change.goals)]);
  // Keep the legacy snapshot compatible during rollout; reads use dated versions.
  const [active] = await connection.execute<DatabaseRow[]>('SELECT targets FROM "foodGoalVersion" WHERE "userId" = $1 AND "effectiveFrom" <= $2::date ORDER BY "effectiveFrom" DESC LIMIT 1', [userId, change.today]);
  if (active.length) await connection.execute('INSERT INTO "foodGoal" ("userId", targets) VALUES ($1, $2::jsonb) ON CONFLICT ("userId") DO UPDATE SET targets = EXCLUDED.targets, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\')', [userId, JSON.stringify(active[0].targets)]);
}
