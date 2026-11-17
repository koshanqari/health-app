import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, type DatabaseRow } from "../src/lib/db";
import { macroCalorieEstimate } from "../src/lib/food";
import { foodGoalProgress, goalMacroValues, goalVersionForDate, parseFoodGoalChange, parseFoodGoals, suggestedFoodGoals } from "../src/lib/food-goals";

const base = process.env.TEST_BASE_URL || "http://localhost:3001";
const emails = [0, 1].map(index => `goals-${randomUUID()}-${index}@example.com`);
const cookies: string[] = [];
const goals = suggestedFoodGoals();
const put = (value: unknown, cookie = cookies[0], origin = base) => fetch(base + "/api/food/goals", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie || "", Origin: origin }, body: JSON.stringify(value) });
const journal = async (cookie = cookies[0]) => {
  const result = await fetch(base + "/api/food?date=2032-04-01", { headers: { Cookie: cookie } });
  assert.equal(result.status, 200);
  return result.json();
};

before(async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname), "Use local Postgres for fixtures.");
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Use a local test server.");
  for (const email of emails) {
    const result = await fetch(base + "/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: base, "X-Forwarded-For": `198.20.${Math.floor(Math.random() * 240) + 1}.1` }, body: JSON.stringify({ email, password: `Goals-${randomUUID()}!`, name: "Goals Test" }) });
    assert.equal(result.status, 200);
    cookies.push(result.headers.getSetCookie().map(value => value.split(";")[0]).join("; "));
  }
});
after(async () => {
  const [users] = await db.execute<DatabaseRow[]>('SELECT id FROM "user" WHERE email IN ($1, $2)', emails);
  for (const user of users) await db.execute('DELETE FROM "user" WHERE id = $1', [user.id]);
  await db.end();
});

test("starter macros match both calorie endpoints using 4/4/9", () => {
  assert.deepEqual(goals.protein, { min: 137.5, max: 156.25 });
  assert.deepEqual(goals.carbs, { min: 275, max: 312.5 });
  assert.deepEqual(goals.fat, { min: 61.11, max: 69.44 });
  for (const bound of ["min", "max"] as const) assert.equal(macroCalorieEstimate(goalMacroValues(goals, bound)), null);
});

test("goals reject inverted, missing, nonfinite, negative, over-limit and overprecise ranges", () => {
  for (const bad of [null, [], {}, { ...goals, protein: undefined }, { ...goals, calories: { min: 2500, max: 2200 } }, { ...goals, calories: { min: 0, max: 2200 } }, ...[NaN, Infinity, -1, "20", 10001, .001].map(min => ({ ...goals, protein: { min, max: 10000 } }))]) assert.throws(() => parseFoodGoals(bad));
  assert.deepEqual(parseFoodGoals({ ...goals, fat: { min: 0, max: 0 } }).fat, { min: 0, max: 0 });
});

test("progress handles exact bounds, range, overage and zero without negative remaining", () => {
  assert.deepEqual(foodGoalProgress(2000, goals.calories), { remainingMin: 200, remainingMax: 500, over: 0, status: "below", percent: 80 });
  for (const value of [2200, 2350, 2500]) assert.equal(foodGoalProgress(value, goals.calories).status, "within");
  assert.deepEqual(foodGoalProgress(2600, goals.calories), { remainingMin: 0, remainingMax: 0, over: 100, status: "over", percent: 100 });
  assert.equal(foodGoalProgress(0, { min: 0, max: 0 }).status, "within");
  assert.equal(foodGoalProgress(1, { min: 0, max: 0 }).percent, 100);
});

test("goals require authentication, trusted origin and JSON", async () => {
  assert.equal((await put(goals, "")).status, 401);
  assert.equal((await put(goals, cookies[0], "https://untrusted.example")).status, 403);
  const unsupported = await fetch(base + "/api/food/goals", { method: "PUT", headers: { Cookie: cookies[0], Origin: base }, body: "text" });
  assert.equal(unsupported.status, 415);
  assert.equal((await put({ ...goals, carbs: { min: 100, max: 20 } })).status, 400);
  assert.equal((await journal()).goals, null);
});

test("goals persist per user, preserve custom macros, and cannot set another owner", async () => {
  const custom = { ...goals, protein: { min: 150, max: 180 } };
  assert.equal((await put({ ...custom, userId: "another-user" })).status, 200);
  assert.deepEqual((await journal()).goals, custom);
  assert.equal((await journal(cookies[1])).goals, null);
  assert.equal((await put(suggestedFoodGoals(2000, 2400), cookies[1])).status, 200);
  assert.deepEqual((await journal()).goals, custom);
  assert.equal((await journal(cookies[1])).goals.calories.min, 2000);
});

test("updating goals preserves meals and calorie/macro mismatch warnings stay nonblocking", async () => {
  const food = { calories: 400, protein: 20, carbs: 50, fat: 10, eatenAtLocal: "2032-04-01T12:00", timeZone: "UTC" };
  const entry = await fetch(base + "/api/food", { method: "POST", headers: { Cookie: cookies[0], Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(food) });
  assert.equal(entry.status, 201);
  const mismatched = { ...goals, protein: { min: 900, max: 1000 } };
  assert.notEqual(macroCalorieEstimate(goalMacroValues(mismatched, "min")), null);
  assert.equal((await put(mismatched)).status, 200);
  const saved = await journal();
  assert.equal(saved.day.calories, 400);
  assert.deepEqual(saved.goals, mismatched);
  assert.equal(saved.day.entries, 1);
});

test("effective dates default to the user's local today and reject invalid dates or zones", () => {
  const now = new Date("2026-01-01T20:00:00Z");
  assert.equal(parseFoodGoalChange({ ...goals, timeZone: "Asia/Kolkata" }, now).effectiveFrom, "2026-01-02");
  assert.equal(parseFoodGoalChange(goals, now).effectiveFrom, "2026-01-01");
  for (const effectiveFrom of [null, "", "2020-02-30", "1999-12-31", "2101-01-01", 20260101]) assert.throws(() => parseFoodGoalChange({ ...goals, effectiveFrom }, now));
  assert.throws(() => parseFoodGoalChange({ ...goals, timeZone: "Not/AZone" }, now));
  const bulk = suggestedFoodGoals(2700, 3000);
  const versions = [{ effectiveFrom: "2020-07-01", goals: bulk }, { effectiveFrom: "2020-01-01", goals }];
  assert.equal(goalVersionForDate(versions, "2019-12-31"), null);
  assert.deepEqual(goalVersionForDate(versions, "2020-06-30")?.goals, goals);
  assert.deepEqual(goalVersionForDate(versions, "2020-07-01")?.goals, bulk);
});

const journalAt = async (date: string) => {
  const response = await fetch(base + "/api/food?date=" + date, { headers: { Cookie: cookies[0] } });
  assert.equal(response.status, 200);
  return response.json();
};

test("dated targets preserve earlier goals and use the new ranges from their exact start date", async () => {
  const bulk = suggestedFoodGoals(2700, 3000);
  assert.equal((await put({ ...bulk, effectiveFrom: "2020-07-01" })).status, 200);
  assert.equal((await put({ ...goals, effectiveFrom: "2020-01-01" })).status, 200);
  assert.equal((await journalAt("2019-12-31")).goals, null);
  assert.deepEqual((await journalAt("2020-06-30")).goals, goals);
  const july = await journalAt("2020-07-01");
  assert.deepEqual(july.goals, bulk);
  assert.equal(july.goalEffectiveFrom, "2020-07-01");
  assert.deepEqual((await journalAt("2020-12-31")).goals, bulk);
});

test("backdated insertion and same-start-date corrections preserve adjacent goal versions", async () => {
  const middle = suggestedFoodGoals(2300, 2600), corrected = suggestedFoodGoals(2800, 3100);
  assert.equal((await put({ ...middle, effectiveFrom: "2020-05-01" })).status, 200);
  assert.deepEqual((await journalAt("2020-04-30")).goals, goals);
  assert.deepEqual((await journalAt("2020-05-01")).goals, middle);
  assert.deepEqual((await journalAt("2020-07-01")).goals, suggestedFoodGoals(2700, 3000));
  assert.equal((await put({ ...corrected, effectiveFrom: "2020-07-01" })).status, 200);
  assert.deepEqual((await journalAt("2020-06-30")).goals, middle);
  assert.deepEqual((await journalAt("2020-07-01")).goals, corrected);
  assert.equal((await put({ ...goals, effectiveFrom: "2020-02-30" })).status, 400);
  const [rows] = await db.execute<DatabaseRow[]>('SELECT COUNT(*)::integer AS count FROM "foodGoalVersion" WHERE "userId" = (SELECT id FROM "user" WHERE email = $1) AND "effectiveFrom" = $2::date', [emails[0], "2020-07-01"]);
  assert.equal(rows[0].count, 1);
});

test("future and concurrent goal changes retain all versions without changing today's target", async () => {
  const before = await journal();
  const future = suggestedFoodGoals(3000, 3300);
  assert.equal((await put({ ...future, effectiveFrom: "2099-01-01" })).status, 200);
  assert.deepEqual((await journal()).goals, before.goals);
  assert.deepEqual((await journalAt("2099-01-01")).goals, future);
  const august = suggestedFoodGoals(2600, 2800), september = suggestedFoodGoals(2700, 2900);
  const results = await Promise.all([put({ ...august, effectiveFrom: "2020-08-01" }), put({ ...september, effectiveFrom: "2020-09-01" })]);
  assert.ok(results.every(response => response.status === 200));
  assert.deepEqual((await journalAt("2020-08-15")).goals, august);
  assert.deepEqual((await journalAt("2020-09-15")).goals, september);
});
