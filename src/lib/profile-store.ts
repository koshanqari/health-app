import { type DatabaseConnection, type DatabaseRow } from "./db";
import { parseProfile, type ProfileChange, type UserProfile } from "./profile";

export class ProfileUpdateError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function migrateProfileDetails(connection: DatabaseConnection) {
  for (const sql of [
    'ALTER TABLE "userProfile" ADD COLUMN IF NOT EXISTS "homePreferences" JSONB CHECK (jsonb_typeof("homePreferences") = \'object\')',
    'ALTER TABLE "userProfile" ADD COLUMN IF NOT EXISTS age INTEGER CHECK (age BETWEEN 0 AND 130)',
    'ALTER TABLE "userProfile" ADD COLUMN IF NOT EXISTS "weightKg" NUMERIC(4,1) CHECK ("weightKg" > 0 AND "weightKg" <= 500)',
    'ALTER TABLE "userProfile" ADD COLUMN IF NOT EXISTS "ageUpdatedAt" TIMESTAMP',
    'ALTER TABLE "userProfile" ADD COLUMN IF NOT EXISTS "weightUpdatedAt" TIMESTAMP',
  ]) await connection.execute(sql);
  // Erase birth dates after converting them once. The empty legacy column supports older
  // deployments during rollout; the new profile API never accepts or returns a birth date.
  await connection.execute(`UPDATE "userProfile" SET
    age = COALESCE(age, EXTRACT(YEAR FROM age((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, "dateOfBirth"))::integer),
    "ageUpdatedAt" = CASE WHEN age IS NULL THEN CURRENT_TIMESTAMP AT TIME ZONE 'UTC' ELSE "ageUpdatedAt" END,
    "dateOfBirth" = NULL WHERE "dateOfBirth" IS NOT NULL`);
  await connection.execute(`CREATE OR REPLACE FUNCTION daywell_legacy_profile_age() RETURNS TRIGGER AS $$
    BEGIN
      IF NEW."dateOfBirth" IS NOT NULL THEN
        NEW.age := EXTRACT(YEAR FROM age((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, NEW."dateOfBirth"))::integer;
        IF NEW."dateOfBirth" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date OR NEW.age NOT BETWEEN 0 AND 130 THEN
          RAISE EXCEPTION 'Invalid legacy profile age';
        END IF;
        NEW."ageUpdatedAt" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
        NEW."dateOfBirth" := NULL;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);
  await connection.execute('DROP TRIGGER IF EXISTS daywell_legacy_profile_age ON "userProfile"');
  await connection.execute('CREATE TRIGGER daywell_legacy_profile_age BEFORE INSERT OR UPDATE ON "userProfile" FOR EACH ROW EXECUTE FUNCTION daywell_legacy_profile_age()');
}

export async function readProfile(connection: Pick<DatabaseConnection, "execute">, userId: string, lock = false): Promise<UserProfile | null> {
  const [rows] = await connection.execute<DatabaseRow[]>(`SELECT u.id, u.name, u.email, u.role, p.age, p.sex, p."avatarId",
    p."heightCm"::double precision AS "heightCm", p."weightKg"::double precision AS "weightKg",
    to_char(p."ageUpdatedAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "ageUpdatedAt",
    to_char(p."weightUpdatedAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "weightUpdatedAt"
    FROM "user" u LEFT JOIN "userProfile" p ON p."userId" = u.id WHERE u.id = $1${lock ? " FOR UPDATE OF u" : ""}`, [userId]);
  return rows[0] as UserProfile ?? null;
}

export async function saveProfileChange(connection: DatabaseConnection, userId: string, value: unknown, expected?: ProfileChange) {
  const existing = await readProfile(connection, userId, true);
  if (!existing) throw new ProfileUpdateError(404, "This profile was not found.");
  if (expected && Object.entries(expected).some(([key, old]) => existing[key as keyof UserProfile] !== old)) throw new ProfileUpdateError(409, "Your profile changed since this proposal. Ask Kay for an updated proposal.");
  let next;
  try { next = parseProfile(value, existing); } catch (error) { throw new ProfileUpdateError(400, error instanceof Error ? error.message : "Check your profile details."); }
  await connection.execute('UPDATE "user" SET name = $1, "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE \'UTC\' WHERE id = $2', [next.name, userId]);
  await connection.execute(`INSERT INTO "userProfile" ("userId", age, sex, "avatarId", "heightCm", "weightKg", "ageUpdatedAt", "weightUpdatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN CURRENT_TIMESTAMP AT TIME ZONE 'UTC' ELSE NULL END,
      CASE WHEN $8::boolean THEN CURRENT_TIMESTAMP AT TIME ZONE 'UTC' ELSE NULL END)
    ON CONFLICT ("userId") DO UPDATE SET age = EXCLUDED.age, sex = EXCLUDED.sex, "avatarId" = EXCLUDED."avatarId", "heightCm" = EXCLUDED."heightCm", "weightKg" = EXCLUDED."weightKg",
      "ageUpdatedAt" = CASE WHEN $7::boolean THEN CURRENT_TIMESTAMP AT TIME ZONE 'UTC' ELSE "userProfile"."ageUpdatedAt" END,
      "weightUpdatedAt" = CASE WHEN $8::boolean THEN CURRENT_TIMESTAMP AT TIME ZONE 'UTC' ELSE "userProfile"."weightUpdatedAt" END,
      "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`, [userId, next.age, next.sex, next.avatarId, next.heightCm, next.weightKg, Object.prototype.hasOwnProperty.call(value, "age"), Object.prototype.hasOwnProperty.call(value, "weightKg")]);
  return (await readProfile(connection, userId))!;
}
