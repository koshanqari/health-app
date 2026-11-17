import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, type DatabaseRow } from "../src/lib/db";
import { parseProfile, profileAvatars } from "../src/lib/profile";

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

test("profile validation accepts optional details, real leap dates and local-day boundaries", () => {
  assert.deepEqual(parseProfile({ name: "  Jordan  " }), { name: "Jordan", dateOfBirth: null, sex: null, avatarId: null });
  assert.equal(parseProfile({ name: "Jordan", dateOfBirth: "2000-02-29", sex: "prefer_not_to_say" }).dateOfBirth, "2000-02-29");
  assert.equal(parseProfile({ name: "Jordan", dateOfBirth: "2026-01-02", timeZone: "Asia/Kolkata" }, undefined, new Date("2026-01-01T20:00:00Z")).dateOfBirth, "2026-01-02");
  for (const body of [{ name: " " }, { name: "x".repeat(81) }, { name: "x\u0000" }, { name: 1 }, { name: "Jordan", dateOfBirth: "1900-02-29" }, { name: "Jordan", dateOfBirth: "2100-01-01" }, { name: "Jordan", dateOfBirth: "1899-12-31" }, { name: "Jordan", sex: "invalid" }, { name: "Jordan", timeZone: "Not/AZone" }, { name: "Jordan", email: "other@example.com" }]) assert.throws(() => parseProfile(body));
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
  assert.equal(body.user.dateOfBirth, null);
  assert.equal(body.user.sex, null);
});

test("profile updates persist name, birth date and sex without changing credentials or role", async () => {
  const [before] = await db.execute<DatabaseRow[]>('SELECT a.password FROM "account" a JOIN "user" u ON u.id = a."userId" WHERE u.email = $1', [emails[0]]);
  const result = await patch({ name: "  Jordan Bloom  ", dateOfBirth: "1992-02-29", sex: "female", timeZone: "Asia/Kolkata" });
  assert.equal(result.status, 200);
  const saved = (await result.json()).user;
  assert.equal(saved.name, "Jordan Bloom"); assert.equal(saved.dateOfBirth, "1992-02-29"); assert.equal(saved.sex, "female");
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
  assert.equal(other.dateOfBirth, null); assert.equal(other.sex, null);
  for (const fields of [{ userId: other.id }, { id: other.id }, { email: "forged@example.com" }, { role: "admin" }, { password: "forged-password" }, { emailVerified: true }]) assert.equal((await patch({ name: "Forged", ...fields })).status, 400);
  assert.equal((await (await get(cookies[1], "?userId=another")).json()).user.name, "Profile Test");
  const owner = (await (await get()).json()).user;
  assert.equal(owner.name, "Jordan Bloom"); assert.equal(owner.email, emails[0]); assert.equal(owner.role, "user");
});

test("partial profile edits retain optional values, which can also be cleared", async () => {
  assert.equal((await patch({ name: "Jordan Updated" })).status, 200);
  const partial = (await (await get()).json()).user;
  assert.equal(partial.dateOfBirth, "1992-02-29"); assert.equal(partial.sex, "female");
  assert.equal((await patch({ dateOfBirth: "", sex: "" })).status, 200);
  const cleared = (await (await get()).json()).user;
  assert.equal(cleared.name, "Jordan Updated"); assert.equal(cleared.dateOfBirth, null); assert.equal(cleared.sex, null);
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
