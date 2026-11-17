import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DatabaseRow } from "../src/lib/db";
import { db } from "../src/lib/db";

const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const run = randomUUID();
const emails = [`food-owner-${run}@example.com`, `food-other-${run}@example.com`];
const cookies: string[] = [];
const sample = { name: "Paneer sandwich", calories: 400, protein: 20, carbs: 50, fat: 10, meal: "lunch", category: "healthy", eatenAtLocal: "2032-04-01T23:55", timeZone: "Asia/Kolkata" };
let healthyId = "", treatId = "", nextDayId = "";

function request(method: string, body?: unknown, cookie = cookies[0], origin = base) {
  return fetch(base + "/api/food", { method, headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie ?? "" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function journal(date = "2032-04-01", cookie = cookies[0]) {
  const response = await fetch(base + "/api/food?date=" + date, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}
async function create(food: object) {
  const result = await request("POST", food);
  assert.equal(result.status, 201);
  return (await result.json()).id as string;
}

before(async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname), "Use local Postgres for fixtures.");
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Use a local test server.");
  for (const [index, email] of emails.entries()) {
    const response = await fetch(base + "/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: base, "X-Forwarded-For": `198.16.${Math.floor(Math.random() * 240) + 1}.${index + 1}` }, body: JSON.stringify({ email, password: "Food-" + randomUUID() + "!", name: "Food Test " + index }) });
    assert.equal(response.status, 200);
    cookies.push(response.headers.getSetCookie().map(value => value.split(";")[0]).join("; "));
  }
});

after(async () => {
  const [users] = await db.execute<DatabaseRow[]>("SELECT id FROM \"user\" WHERE email IN ($1, $2)", emails);
  for (const user of users) {
    await db.execute("DELETE FROM \"session\" WHERE \"userId\" = $1", [user.id]);
    await db.execute("DELETE FROM \"account\" WHERE \"userId\" = $1", [user.id]);
    await db.execute("DELETE FROM \"user\" WHERE id = $1", [user.id]);
  }
  await db.end();
});

test("food API requires a session and rejects foreign-origin writes", async () => {
  assert.equal((await fetch(base + "/api/food?date=2032-04-01")).status, 401);
  for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await request(method, sample, "")).status, 401);
  assert.equal((await request("POST", sample, cookies[0], "https://untrusted.example")).status, 403);
  assert.equal((await journal()).day.entries, 0);
});

test("food validation rejects missing nutrition, invalid dates, and unsupported categories", async () => {
  for (const bad of [
    { calories: -1 }, { protein: "20" }, { carbs: null }, { fat: 1.234 }, { name: true },
    { calories: undefined }, { fat: undefined }, { protein: undefined }, { carbs: undefined },
    { category: "mixed" }, { category: null }, { meal: "brunch" }, { eatenAtLocal: "2032-02-30T12:00" },
    { eatenAtLocal: "2032-04-01T25:00" }, { timeZone: "Not/AZone" }, { calories: 100001 },
  ]) {
    const result = await request("POST", { ...sample, ...bad });
    assert.equal(result.status, 400, JSON.stringify(bad));
  }
  const invalid = await fetch(base + "/api/food?date=2032-02-30", { headers: { Cookie: cookies[0] } });
  assert.equal(invalid.status, 400);
  const malformed = await fetch(base + "/api/food", { method: "POST", headers: { Cookie: cookies[0], Origin: base, "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal((await journal()).day.entries, 0);
});

test("four nutrition values alone create an unnamed Healthy entry with automatic date and no meal", async () => {
  const before = new Date().toISOString().slice(0, 10);
  const id = await create({ calories: 225, fat: 5, protein: 10, carbs: 30 });
  const [rows] = await db.execute<DatabaseRow[]>("SELECT name, meal, category, \"timeZone\", to_char(\"eatenAtLocal\", 'YYYY-MM-DD') AS date FROM \"foodEntry\" WHERE id = $1", [id]);
  assert.equal(rows[0].name, "");
  assert.equal(rows[0].meal, null);
  assert.equal(rows[0].category, "healthy");
  assert.equal(rows[0].timeZone, "UTC");
  assert.ok([before, new Date().toISOString().slice(0, 10)].includes(rows[0].date));
  assert.equal((await request("DELETE", { id })).status, 200);
});

test("food entries persist local dates and correctly aggregate daily and monthly nutrition", async () => {
  healthyId = await create(sample);
  treatId = await create({ ...sample, name: "Fries", calories: 200, protein: 2, carbs: 22, fat: 12, category: "unhealthy" });
  nextDayId = await create({ ...sample, name: "Chips", calories: 100, protein: 1, carbs: 10, fat: 6, category: "unhealthy", eatenAtLocal: "2032-04-02T00:05" });
  await create({ ...sample, calories: 900, eatenAtLocal: "2032-05-01T12:00" });
  const result = await journal();
  assert.deepEqual(result.day, { entries: 2, calories: 600, protein: 22, carbs: 72, fat: 22, unhealthyEntries: 1, unhealthyCalories: 200 });
  assert.equal(result.month.entries, 3);
  assert.equal(result.month.calories, 700);
  assert.equal(result.month.unhealthyEntries, 2);
  assert.equal(result.month.unhealthyCalories, 300);
  assert.equal(result.entries.find((entry: { id: string }) => entry.id === healthyId).eatenAtLocal, sample.eatenAtLocal);
  assert.equal((await journal("2032-04-02")).entries.length, 1);
});

test("other members cannot read, edit, or delete another member’s food", async () => {
  const other = await journal("2032-04-01", cookies[1]);
  assert.equal(other.entries.length, 0);
  assert.equal(other.month.entries, 0);
  assert.equal((await request("PATCH", { ...sample, id: healthyId }, cookies[1])).status, 404);
  assert.equal((await request("DELETE", { id: healthyId }, cookies[1])).status, 404);
  assert.equal((await journal()).day.entries, 2);
});

test("editing category, nutrition, and date refreshes both periods; unchanged edits succeed", async () => {
  assert.equal((await request("PATCH", { ...sample, id: healthyId })).status, 200);
  assert.equal((await request("PATCH", { id: treatId, name: "Fries" })).status, 200);
  const preserved = (await journal()).entries.find((entry: { id: string }) => entry.id === treatId);
  assert.equal(preserved.category, "unhealthy");
  assert.equal(preserved.eatenAtLocal, sample.eatenAtLocal);
  assert.equal((await request("PATCH", { ...sample, id: treatId, name: "Fries edited", calories: 225.5, category: "healthy", eatenAtLocal: "2032-04-02T18:15" })).status, 200);
  const result = await journal();
  assert.equal(result.day.entries, 1);
  assert.equal(result.day.calories, 400);
  assert.equal(result.day.unhealthyEntries, 0);
  assert.equal(result.month.calories, 725.5);
  assert.equal(result.month.unhealthyEntries, 1);
  assert.equal(result.month.unhealthyCalories, 100);
  const moved = (await journal("2032-04-02")).entries.find((entry: { id: string }) => entry.id === treatId);
  assert.equal(moved.name, "Fries edited");
  assert.equal(moved.category, "healthy");
});

test("deletion updates totals, and zero-calorie entries remain valid without an invented percentage", async () => {
  assert.equal((await request("DELETE", { id: nextDayId })).status, 200);
  assert.equal((await request("DELETE", { id: nextDayId })).status, 404);
  assert.equal((await journal()).month.unhealthyEntries, 0);
  const zeroId = await create({ ...sample, name: "Water", calories: 0, protein: 0, carbs: 0, fat: 0, eatenAtLocal: "2032-06-01T12:00" });
  const zero = await journal("2032-06-01");
  assert.equal(zero.day.entries, 1);
  assert.equal(zero.day.calories, 0);
  assert.equal((await request("DELETE", { id: zeroId })).status, 200);
  assert.equal((await journal("2032-06-01")).month.entries, 0);
});
