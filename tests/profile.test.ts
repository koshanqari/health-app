import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, type DatabaseRow } from "../src/lib/db";
import { migrateProfileDetails } from "../src/lib/profile-store";
import { parseProfile, parseProfileChange, profileAvatars } from "../src/lib/profile";

const base = process.env.TEST_BASE_URL || "http://localhost:3001";
const emails = [0, 1].map(index => `profile-${randomUUID()}-${index}@example.com`);
const cookies: string[] = [];
const get = (cookie = cookies[0], query = "") => fetch(base + "/api/account" + query, { headers: { Cookie: cookie || "" } });
const patch = (body: unknown, cookie = cookies[0], origin = base) => fetch(base + "/api/account", { method: "PATCH", headers: { Cookie: cookie || "", Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });

before(async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname), "Use local Postgres for fixtures.");
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Use a local test server.");
  for (const email of emails) {
    const result = await fetch(base + "/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: base, "X-Forwarded-For": `198.22.${Math.floor(Math.random() * 240) + 1}.1` }, body: JSON.stringify({ name: "Profile Test", email, password: `Profile-${randomUUID()}!` }) });
    assert.equal(result.status, 200);
    cookies.push(result.headers.getSetCookie().map(value => value.split(";")[0]).join("; "));
  }
});
after(async () => {
  const [users] = await db.execute<DatabaseRow[]>('SELECT id FROM "user" WHERE email IN ($1, $2)', emails);
  for (const user of users) await db.execute('DELETE FROM "user" WHERE id = $1', [user.id]);
  await db.end();
});

test("profile validation accepts optional age and weight with strict units and precision", () => {
  assert.deepEqual(parseProfile({ name: "  Jordan  " }), { name: "Jordan", age: null, weightKg: null, sex: null, avatarId: null, heightCm: null });
  assert.equal(parseProfile({ name: "Jordan", age: 28, weightKg: 78.5, sex: "prefer_not_to_say" }).age, 28);
  assert.deepEqual(parseProfileChange({ weightKg: 76 }), { weightKg: 76 });
  for (const body of [{ name: " " }, { name: "x".repeat(81) }, { name: "x\u0000" }, { name: 1 }, { name: "Jordan", dateOfBirth: "2000-01-01" }, { name: "Jordan", age: -1 }, { name: "Jordan", age: 131 }, { name: "Jordan", age: 28.5 }, { name: "Jordan", age: "28" }, { name: "Jordan", weightKg: 0 }, { name: "Jordan", weightKg: 500.1 }, { name: "Jordan", weightKg: 78.55 }, { name: "Jordan", weightKg: "78" }, { name: "Jordan", sex: "invalid" }, { name: "Jordan", timeZone: "Not/AZone" }, { name: "Jordan", email: "other@example.com" }]) assert.throws(() => parseProfile(body));
  for (const change of [{}, { name: "Renamed" }, { role: "admin" }, { ageUpdatedAt: "2020-01-01" }]) assert.throws(() => parseProfileChange(change));
});

test("profile reads and writes require authentication, trusted origins and JSON", async () => {
  assert.equal((await get("")).status, 401);
  assert.equal((await patch({ name: "Jordan" }, "")).status, 401);
  assert.equal((await patch({ name: "Jordan" }, cookies[0], "https://untrusted.example")).status, 403);
  assert.equal((await fetch(base + "/api/account", { method: "PATCH", headers: { Cookie: cookies[0], Origin: base }, body: "text" })).status, 415);
  assert.equal((await patch({ name: " " })).status, 400);
  assert.equal((await patch({ dateOfBirth: "2026-02-30" })).status, 400);
  const response = await get(), body = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal("dateOfBirth" in body.user, false);
  assert.equal(body.user.age, null); assert.equal(body.user.weightKg, null);
  assert.equal(body.user.sex, null);
});

test("profile updates persist name, age, weight and sex without changing credentials or role", async () => {
  const [before] = await db.execute<DatabaseRow[]>('SELECT a.password FROM "account" a JOIN "user" u ON u.id = a."userId" WHERE u.email = $1', [emails[0]]);
  const result = await patch({ name: "  Jordan Bloom  ", age: 34, weightKg: 78.5, sex: "female", timeZone: "Asia/Kolkata" });
  assert.equal(result.status, 200);
  const saved = (await result.json()).user;
  assert.equal(saved.name, "Jordan Bloom"); assert.equal(saved.age, 34); assert.equal(saved.weightKg, 78.5); assert.ok(saved.ageUpdatedAt); assert.ok(saved.weightUpdatedAt); assert.equal(saved.sex, "female");
  assert.equal(saved.email, emails[0]); assert.equal(saved.role, "user");
  assert.equal("password" in saved, false);
  assert.deepEqual((await (await get()).json()).user, saved);
  const [afterRows] = await db.execute<DatabaseRow[]>('SELECT a.password FROM "account" a JOIN "user" u ON u.id = a."userId" WHERE u.email = $1', [emails[0]]);
  assert.ok(afterRows[0].password === before[0].password, "Updating a profile must not change the password hash.");
  const app = await fetch(base + "/app", { headers: { Cookie: cookies[0] } });
  assert.ok((await app.text()).includes("Jordan"));
});

test("members cannot read or update another profile or change sign-in fields", async () => {
  const other = (await (await get(cookies[1])).json()).user;
  assert.equal(other.age, null); assert.equal(other.weightKg, null); assert.equal(other.sex, null);
  for (const fields of [{ userId: other.id }, { id: other.id }, { email: "forged@example.com" }, { role: "admin" }, { password: "forged-password" }, { emailVerified: true }]) assert.equal((await patch({ name: "Forged", ...fields })).status, 400);
  assert.equal((await (await get(cookies[1], "?userId=another")).json()).user.name, "Profile Test");
  const owner = (await (await get()).json()).user;
  assert.equal(owner.name, "Jordan Bloom"); assert.equal(owner.email, emails[0]); assert.equal(owner.role, "user");
});

test("partial profile edits retain optional values, which can also be cleared", async () => {
  assert.equal((await patch({ name: "Jordan Updated" })).status, 200);
  const partial = (await (await get()).json()).user;
  assert.equal(partial.age, 34); assert.equal(partial.weightKg, 78.5); assert.equal(partial.sex, "female");
  assert.equal((await patch({ age: null, weightKg: null, sex: "" })).status, 200);
  const cleared = (await (await get()).json()).user;
  assert.equal(cleared.name, "Jordan Updated"); assert.equal(cleared.age, null); assert.equal(cleared.weightKg, null); assert.equal(cleared.sex, null);
});

test("only built-in avatar IDs are accepted, saved per user, and preserved by partial edits", async () => {
  for (const { id } of profileAvatars) {
    assert.equal((await patch({ avatarId: id })).status, 200);
    assert.equal((await (await get()).json()).user.avatarId, id);
  }
  assert.equal((await patch({ name: "Avatar Test" })).status, 200);
  assert.equal((await (await get()).json()).user.avatarId, "panda");
  assert.equal((await (await get(cookies[1])).json()).user.avatarId, null);
  for (const avatarId of ["https://example.com/avatar.png", "../../image", "unknown", 1, {}, []]) assert.equal((await patch({ avatarId })).status, 400);
  assert.equal((await patch({ avatarId: "cat", role: "admin" })).status, 400);
  assert.equal((await (await get()).json()).user.avatarId, "panda");
  assert.equal((await patch({ avatarId: null })).status, 200);
  assert.equal((await (await get()).json()).user.avatarId, null);
});

test("optional height persists as centimetres, survives partial edits, and can be cleared", async () => {
  for (const heightCm of [NaN, Infinity, -1, 0, 300.1, 175.55, "175.5"]) assert.throws(() => parseProfile({ name: "Jordan", heightCm }));
  assert.equal((await patch({ heightCm: 175.5 })).status, 200);
  assert.equal((await (await get()).json()).user.heightCm, 175.5);
  assert.equal((await (await get(cookies[1])).json()).user.heightCm, null);
  assert.equal((await patch({ name: "Height Test" })).status, 200);
  assert.equal((await (await get()).json()).user.heightCm, 175.5);
  for (const heightCm of [-1, 0, 301, 175.55, "175.5", {}]) assert.equal((await patch({ heightCm })).status, 400);
  assert.equal((await (await get()).json()).user.heightCm, 175.5);
  assert.equal((await patch({ heightCm: null })).status, 200);
  assert.equal((await (await get()).json()).user.heightCm, null);
});

test("legacy birth dates convert to age once, are erased, and migration reruns preserve saved ages", async () => {
  const user = (await (await get(cookies[1])).json()).user;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    // Simulate a legacy database row before the compatibility trigger exists.
    await connection.execute('DROP TRIGGER daywell_legacy_profile_age ON "userProfile"');
    await connection.execute('INSERT INTO "userProfile" ("userId", "dateOfBirth") VALUES ($1, \'2000-01-01\') ON CONFLICT ("userId") DO UPDATE SET "dateOfBirth" = EXCLUDED."dateOfBirth", age = NULL', [user.id]);
    await migrateProfileDetails(connection);
    const [rows] = await connection.execute<DatabaseRow[]>('SELECT age, "dateOfBirth", "ageUpdatedAt", EXTRACT(YEAR FROM age((CURRENT_TIMESTAMP AT TIME ZONE \'UTC\')::date, DATE \'2000-01-01\'))::integer AS expected FROM "userProfile" WHERE "userId" = $1', [user.id]);
    assert.equal(rows[0].age, rows[0].expected); assert.equal(rows[0].dateOfBirth, null); assert.ok(rows[0].ageUpdatedAt);
    await connection.execute('UPDATE "userProfile" SET age = 42 WHERE "userId" = $1', [user.id]);
    await migrateProfileDetails(connection);
    const [again] = await connection.execute<DatabaseRow[]>('SELECT age, "dateOfBirth" FROM "userProfile" WHERE "userId" = $1', [user.id]);
    assert.equal(again[0].age, 42); assert.equal(again[0].dateOfBirth, null);
  } finally { await connection.rollback(); connection.release(); }
});

test("confirming the same weight refreshes its date while unrelated edits preserve that date", async () => {
  const user = (await (await get()).json()).user;
  await patch({ weightKg: 78 });
  await db.execute('UPDATE "userProfile" SET "weightUpdatedAt" = TIMESTAMP \'2000-01-01 00:00:00\' WHERE "userId" = $1', [user.id]);
  await patch({ name: "Current name" });
  assert.equal((await (await get()).json()).user.weightUpdatedAt, "2000-01-01T00:00:00Z");
  await patch({ weightKg: 78 });
  assert.notEqual((await (await get()).json()).user.weightUpdatedAt, "2000-01-01T00:00:00Z");
});
