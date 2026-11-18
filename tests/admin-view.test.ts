import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, type DatabaseRow } from "../src/lib/db";

const base = process.env.TEST_BASE_URL || "http://localhost:3001";
const users: { id: string; cookie: string; email: string; password: string }[] = [];
const scope = "view-test-" + randomUUID();
const headers = (cookie = users[0].cookie) => ({ Cookie: cookie, Origin: base, "Content-Type": "application/json" });
const start = (cookie = users[0].cookie, userId = users[1].id) => fetch(base + "/api/admin/views", { method: "POST", headers: headers(cookie), body: JSON.stringify({ userId }) });
const open = async () => {
  const response = await start(); assert.equal(response.status, 200);
  return new URL((await response.json()).url, base).searchParams.get("view")!;
};
const read = (path: string, token: string, cookie = users[0].cookie) => fetch(base + path + (path.includes("?") ? "&" : "?") + "view=" + token, { headers: headers(cookie) });

before(async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname));
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  for (let i = 0; i < 3; i++) {
    const email = `view-${randomUUID()}@example.com`, password = randomUUID() + "!";
    const response = await fetch(base + "/api/auth/sign-up/email", { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-Forwarded-For": `198.29.${Math.floor(Math.random() * 240) + 1}.${i + 1}` }, body: JSON.stringify({ name: `View fixture ${i}`, email, password }) });
    assert.equal(response.status, 200);
    users.push({ email, password, id: (await response.json()).user.id, cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") });
  }
});
beforeEach(async () => {
  await db.execute('UPDATE "user" SET role = \'admin\' WHERE id = ANY($1::text[])', [[users[0].id, users[2].id]]);
  await db.execute('UPDATE "adminView" SET "endedAt" = CURRENT_TIMESTAMP AT TIME ZONE \'UTC\' WHERE "actorId" = ANY($1::text[])', [[users[0].id, users[2].id]]);
});
after(async () => {
  await db.execute('DELETE FROM "adminView" WHERE "actorId" = ANY($1::text[])', [[users[0].id, users[2].id]]);
  await db.execute('DELETE FROM "foodAiUsage" WHERE scope = $1', [scope]);
  await db.execute('DELETE FROM "foodAiBudget" WHERE scope = $1', [scope]);
  for (const user of users) await db.execute('DELETE FROM "user" WHERE id = $1', [user.id]);
  await db.end();
});

test("only an authenticated admin can start a view, with trusted origin and validated target", async () => {
  assert.equal((await start("")).status, 401);
  assert.equal((await start(users[1].cookie)).status, 403);
  assert.equal((await fetch(base + "/api/admin/views", { method: "POST", headers: { ...headers(), Origin: "https://outside.example" }, body: JSON.stringify({ userId: users[1].id }) })).status, 403);
  assert.equal((await start(users[0].cookie, "")).status, 400);
  assert.equal((await start(users[0].cookie, randomUUID())).status, 404);
});

test("view tokens are tied to the real admin session and never replace its identity", async () => {
  const token = await open();
  assert.equal((await read("/api/account", token, "")).status, 401);
  assert.equal((await read("/api/account", token, users[1].cookie)).status, 401);
  assert.equal((await read("/api/account", token, users[2].cookie)).status, 401);
  const login = await fetch(base + "/api/auth/sign-in/email", { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-Forwarded-For": "198.29.240.240" }, body: JSON.stringify({ email: users[0].email, password: users[0].password }) });
  assert.equal(login.status, 200);
  const differentSession = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  assert.equal((await read("/api/account", token, differentSession)).status, 401);

  assert.equal((await read("/api/account", "0".repeat(64))).status, 401);
  assert.equal((await (await read("/api/account", token)).json()).user.id, users[1].id);
  assert.equal((await (await fetch(base + "/api/account", { headers: headers() })).json()).user.id, users[0].id);
  assert.equal((await read("/api/credits?userId=" + users[2].id, token)).status, 403);
  const [audit] = await db.execute<DatabaseRow[]>('SELECT "tokenHash", "targetId", "adminSessionId" FROM "adminView" WHERE "actorId" = $1 AND "endedAt" IS NULL', [users[0].id]);
  assert.equal(audit[0].targetId, users[1].id); assert.notEqual(audit[0].tokenHash, token); assert.ok(audit[0].adminSessionId);
});

test("all member mutations are refused before provider calls, parsing or target updates", async () => {
  const token = await open();
  for (const [path, method] of [["/api/account", "PATCH"], ["/api/food", "POST"], ["/api/food", "PATCH"], ["/api/food", "DELETE"], ["/api/food/goals", "PUT"], ["/api/food/chat", "POST"], ["/api/food/chat", "PATCH"], ["/api/food/chat", "DELETE"], ["/api/food/analyze", "POST"], ["/api/credits", "POST"]]) {
    const response = await fetch(base + path + "?view=" + token, { method, headers: headers(), body: "{}" });
    assert.equal(response.status, 403, path + " " + method);
    assert.match((await response.json()).message, /read-only/);
  }
});

test("read-only chat and credit reads preserve stale pending messages, expired caches and held credits", async () => {
  const chatId = randomUUID(), requestId = randomUUID(), usageId = randomUUID();
  await db.execute('INSERT INTO "foodAiBudget" (scope, month) VALUES ($1, \'2026-01\')', [scope]);
  await db.execute(`INSERT INTO "foodAiUsage" (id, scope, "budgetMonth", "userId", "imageHash", status, "costMicros", "createdAt", "creditReservedCents", "creditHoldActive", "creditMultiplierHundred", "creditFxCents", "resultJson", "cacheExpiresAt")
    VALUES ($1, $2, '2026-01', $3, $4, 'pending', 10000, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '10 minutes', 100, TRUE, 100, 10000, '{"fixture":true}', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 minute')`, [usageId, scope, users[1].id, "a".repeat(64)]);
  await db.execute('UPDATE "creditWallet" SET "heldCents" = 100 WHERE "userId" = $1', [users[1].id]);
  await db.execute(`INSERT INTO "foodChat" (id, "userId", version, "pendingToken", "pendingRequestId", "pendingStartedAt") VALUES ($1, $2, 7, 'stale-fixture', $3, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '10 minutes')`, [chatId, users[1].id, requestId]);
  await db.execute(`INSERT INTO "foodChatMessage" (id, "chatId", "requestId", role, content, payload, "createdAt") VALUES ($1, $2, $1, 'user', 'Private view fixture', '{"state":"pending"}', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`, [requestId, chatId]);
  const snapshot = async () => {
    const [wallet] = await db.execute('SELECT * FROM "creditWallet" WHERE "userId" = $1', [users[1].id]);
    const [chat] = await db.execute('SELECT * FROM "foodChat" WHERE id = $1', [chatId]);
    const [message] = await db.execute('SELECT * FROM "foodChatMessage" WHERE id = $1', [requestId]);
    const [usage] = await db.execute('SELECT * FROM "foodAiUsage" WHERE id = $1', [usageId]);
    return { wallet, chat, message, usage };
  };
  const before = await snapshot(), token = await open();
  for (const path of ["/api/account", "/api/credits", "/api/food?date=2026-11-18", "/api/food/history?period=W&date=2026-11-18", "/api/food/analyze"]) assert.equal((await read(path, token)).status, 200, path);
  const chat = await (await read("/api/food/chat", token)).json();
  assert.equal(chat.pending, true); assert.equal(chat.version, 7); assert.equal(chat.messages[0].content, "Private view fixture");
  assert.deepEqual(await snapshot(), before);
});

test("exit, expiry and admin-role revocation invalidate scoped access", async () => {
  let token = await open();
  const close = await fetch(base + "/api/admin/views", { method: "DELETE", headers: headers(), body: JSON.stringify({ token }) });
  assert.equal(close.status, 200); assert.equal((await read("/api/account", token)).status, 401);
  const [closed] = await db.execute<DatabaseRow[]>('SELECT COUNT(*)::integer AS total FROM "adminView" WHERE "actorId" = $1 AND "endedAt" IS NOT NULL', [users[0].id]);
  assert.ok(closed[0].total > 0);
  token = await open();
  await db.execute('UPDATE "adminView" SET "expiresAt" = (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\') - INTERVAL \'1 second\' WHERE "actorId" = $1 AND "endedAt" IS NULL', [users[0].id]);
  assert.equal((await read("/api/account", token)).status, 401);
  token = await open();
  await db.execute('UPDATE "user" SET role = \'user\' WHERE id = $1', [users[0].id]);
  assert.equal((await read("/api/account", token)).status, 401);
});
