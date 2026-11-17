import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, type DatabaseRow } from "../src/lib/db";
import { completeHistoryDays, foodHistoryWindow, historyDayStatus, shiftHistoryAnchor, type FoodHistoryData } from "../src/lib/food-history";
import { goalVersionForDate, suggestedFoodGoals, suggestedMacros } from "../src/lib/food-goals";

const base = process.env.TEST_BASE_URL || "http://localhost:3001";
const emails = [0, 1].map(index => `history-${randomUUID()}-${index}@example.com`);
const cookies: string[] = [];
const history = (period = "W", date = "2020-01-22", cookie = cookies[0]) => fetch(`${base}/api/food/history?period=${period}&date=${date}`, { headers: { Cookie: cookie || "" } });
const goals = suggestedFoodGoals();

before(async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname), "Use local Postgres for fixtures.");
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Use a local test server.");
  for (const email of emails) {
    const result = await fetch(base + "/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: base, "X-Forwarded-For": `198.21.${Math.floor(Math.random() * 240) + 1}.1` }, body: JSON.stringify({ email, password: `History-${randomUUID()}!`, name: "History Test" }) });
    assert.equal(result.status, 200);
    cookies.push(result.headers.getSetCookie().map(value => value.split(";")[0]).join("; "));
  }
});
after(async () => {
  const [users] = await db.execute<DatabaseRow[]>('SELECT id FROM "user" WHERE email IN ($1, $2)', emails);
  for (const user of users) await db.execute('DELETE FROM "user" WHERE id = $1', [user.id]);
  await db.end();
});

test("history periods use complete calendar windows, leap years and safe month transitions", () => {
  assert.deepEqual(foodHistoryWindow("W", "2026-11-17"), { start: "2026-11-16", end: "2026-11-22" });
  assert.deepEqual(foodHistoryWindow("M", "2024-02-29"), { start: "2024-02-01", end: "2024-02-29" });
  assert.deepEqual(foodHistoryWindow("6M", "2026-11-17"), { start: "2026-06-01", end: "2026-11-30" });
  const year = foodHistoryWindow("Y", "2024-02-29");
  assert.equal(completeHistoryDays(year.start, year.end, []).length, 366);
  assert.equal(shiftHistoryAnchor("M", "2026-01-31", 1), "2026-02-01");
  assert.equal(shiftHistoryAnchor("Y", "2024-02-29", 1), "2025-02-01");
  assert.equal(shiftHistoryAnchor("6M", "2026-11-30", -1), "2026-05-01");
  assert.equal(foodHistoryWindow("W", "2100-12-31").end, "2100-12-31");
});

test("only logged, nonfuture days inside both inclusive bounds achieve the selected goal", () => {
  const day = { date: "2020-01-20", entries: 1, calories: 2200, ...suggestedMacros(2200) };
  assert.equal(historyDayStatus(day, goals, "calories", "2026-11-17"), "achieved");
  assert.equal(historyDayStatus({ ...day, calories: 2500 }, goals, "calories", "2026-11-17"), "achieved");
  assert.equal(historyDayStatus({ ...day, calories: 2500.01 }, goals, "calories", "2026-11-17"), "outside");
  assert.equal(historyDayStatus({ ...day, calories: 2199.99 }, goals, "calories", "2026-11-17"), "outside");
  assert.equal(historyDayStatus({ ...day, entries: 0 }, goals, "calories", "2026-11-17"), "unlogged");
  assert.equal(historyDayStatus(day, goals, "protein", "2019-01-01"), "future");
  assert.equal(historyDayStatus(day, null, "calories", "2026-11-17"), "no-goal");
});

test("history API requires auth and rejects unsupported daily or malformed filters", async () => {
  assert.equal((await history("W", "2020-01-22", "")).status, 401);
  for (const [period, date] of [["D", "2020-01-22"], ["W", "2020-02-30"], ["all", "2020-01-22"], ["Y", "1999-01-01"]]) assert.equal((await history(period, date)).status, 400);
});

test("history aggregates all owned meals by their local date and fills unlogged days", async () => {
  const goalResponse = await fetch(base + "/api/food/goals", { method: "PUT", headers: { Cookie: cookies[0], Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ ...goals, effectiveFrom: "2020-01-01" }) });
  assert.equal(goalResponse.status, 200);
  for (const [date, calories] of [["2020-01-20T00:05", 1100], ["2020-01-20T23:55", 1100], ["2020-01-21T12:00", 2500], ["2020-01-22T12:00", 2501], ["2020-02-01T00:01", 999]] as const) {
    const result = await fetch(base + "/api/food", { method: "POST", headers: { Cookie: cookies[0], Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ calories, ...suggestedMacros(calories), eatenAtLocal: date, timeZone: "Asia/Kolkata" }) });
    assert.equal(result.status, 201);
  }
  const response = await history(), result = await response.json() as FoodHistoryData;
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(result.days.length, 7);
  assert.equal(result.days[0].date, "2020-01-20");
  assert.equal(result.days[0].entries, 2);
  assert.equal(result.days[0].calories, 2200);
  assert.equal(result.days[0].protein, 137.5);
  assert.equal(result.days[3].calories, 0);
  assert.equal(result.days[3].entries, 0);
  assert.deepEqual(result.goals, goals);
  assert.equal(result.days.filter(day => historyDayStatus(day, result.goals, "calories", "2026-11-17") === "achieved").length, 2);
  const other = await (await history("M", "2020-01-22", cookies[1])).json() as FoodHistoryData;
  assert.ok(other.days.every(day => day.entries === 0));
  assert.equal(other.goals, null);
});

test("long views retain individual daily totals and refresh after corrections", async () => {
  const month = await (await history("M")).json() as FoodHistoryData;
  assert.equal(month.days.length, 31);
  assert.equal(month.days.reduce((sum, day) => sum + day.calories, 0), 7201);
  const halfYear = await (await history("6M")).json() as FoodHistoryData;
  assert.ok(halfYear.days.length >= 181 && halfYear.days.length <= 184);
  const year = await (await history("Y")).json() as FoodHistoryData;
  assert.equal(year.days.length, 366);
  const journal = await (await fetch(base + "/api/food?date=2020-01-22", { headers: { Cookie: cookies[0] } })).json();
  const correction = await fetch(base + "/api/food", { method: "PATCH", headers: { Cookie: cookies[0], Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ id: journal.entries[0].id, calories: 2400 }) });
  assert.equal(correction.status, 200);
  const corrected = await (await history()).json() as FoodHistoryData;
  assert.equal(corrected.days[2].calories, 2400);
  assert.equal(historyDayStatus(corrected.days[2], corrected.goals, "calories", "2026-11-17"), "achieved");
});

test("history uses each day's historical macros and excludes days before goal setup", async () => {
  const bulk = suggestedFoodGoals(2700, 3000);
  const changed = await fetch(base + "/api/food/goals", { method: "PUT", headers: { Cookie: cookies[0], Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ ...bulk, effectiveFrom: "2020-07-01" }) });
  assert.equal(changed.status, 200);
  for (const [date, calories] of [["2019-12-31", 2300], ["2020-06-30", 2300], ["2020-07-01", 2300], ["2020-07-02", 2800]] as const) {
    const result = await fetch(base + "/api/food", { method: "POST", headers: { Cookie: cookies[0], Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ calories, ...suggestedMacros(calories), eatenAtLocal: date + "T12:00", timeZone: "Asia/Kolkata" }) });
    assert.equal(result.status, 201);
  }
  const year = await (await history("Y")).json() as FoodHistoryData;
  assert.equal(year.goalVersions.length, 2);
  for (const [date, status] of [["2020-06-30", "achieved"], ["2020-07-01", "outside"], ["2020-07-02", "achieved"]] as const) {
    const day = year.days.find(day => day.date === date)!;
    const target = goalVersionForDate(year.goalVersions, date)!.goals;
    assert.equal(historyDayStatus(day, target, "calories", "2026-11-17"), status);
    assert.equal(historyDayStatus(day, target, "protein", "2026-11-17"), status);
  }
  const previous = await (await history("M", "2019-12-31")).json() as FoodHistoryData;
  assert.equal(previous.goalVersions.length, 0);
  assert.equal(historyDayStatus(previous.days.at(-1)!, null, "calories", "2026-11-17"), "no-goal");
  const later = await (await history("M", "2020-08-01")).json() as FoodHistoryData;
  assert.equal(later.goalVersions[0].effectiveFrom, "2020-07-01");
  const other = await (await history("Y", "2020-07-01", cookies[1])).json() as FoodHistoryData;
  assert.deepEqual(other.goalVersions, []);
});
