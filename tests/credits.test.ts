import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { db, type DatabaseRow } from "../src/lib/db";
import { administerCredits, creditCharge, creditSettings, migrateCredits, CreditError, getCreditDetails, refundUndeliveredReply, reserveCredits, settleCredits } from "../src/lib/credits";
import { FoodAiError, requestFoodAi, type FoodAiSettings } from "../src/lib/food-ai";

const base = process.env.TEST_BASE_URL || "http://localhost:3001";
const users: { id: string; cookie: string }[] = [], scopes: string[] = [];
const config = (): FoodAiSettings => { const scope = "credits-" + randomUUID(); scopes.push(scope); return { scope, apiKey: "fake", globalDailyLimit: 100, monthlyBudgetMicros: 1_000_000 }; };
const hash = () => createHash("sha256").update(randomUUID()).digest("hex");
const reply: typeof fetch = async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 500 } });
const run = (settings: FoodAiSettings, fetcher = reply, key = hash()) => requestFoodAi(users[0].id, key, {}, value => value as { ok: boolean }, { settings, fetcher });
const operation = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), userId: users[0].id, action: "topup", amount: 50, amountPaid: 50, reason: "Offline payment fixture", ...extra });
const post = (body: unknown, cookie = users[1].cookie, origin = base) => fetch(base + "/api/credits", { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
before(async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname));
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  for (let index = 0; index < 3; index++) {
    const response = await fetch(base + "/api/auth/sign-up/email", { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-Forwarded-For": `198.27.${Math.floor(Math.random() * 240) + 1}.${index + 1}` }, body: JSON.stringify({ name: "Credit fixture", email: `credits-${randomUUID()}@example.com`, password: randomUUID() + "-Credits!", credits: 9999, multiplier: 0 }) });
    assert.equal(response.status, 200);
    users.push({ id: (await response.json()).user.id, cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") });
  }
  const defaults = creditSettings();
  for (const user of users) {
    const wallet = await getCreditDetails(user.id);
    assert.equal(wallet.balance, defaults.welcomeCents / 100);
    assert.equal(wallet.multiplier, defaults.defaultMultiplierHundred / 100);
    assert.equal(wallet.transactions.filter(row => row.kind === "welcome").length, 1);
  }
  await db.execute('UPDATE "user" SET role = \'admin\' WHERE id = $1', [users[1].id]);
});
beforeEach(async () => {
  for (const scope of scopes) await db.execute('DELETE FROM "foodAiUsage" WHERE scope = $1', [scope]);
  await db.execute('DELETE FROM "creditLedger" WHERE "userId" = ANY($1::text[]) AND kind <> \'welcome\'', [users.map(user => user.id)]);
  await db.execute('UPDATE "creditWallet" SET "balanceCents" = 2000, "heldCents" = 0, "multiplierHundred" = 200 WHERE "userId" = ANY($1::text[])', [users.map(user => user.id)]);
});
after(async () => {
  for (const scope of scopes) { await db.execute('DELETE FROM "foodAiUsage" WHERE scope = $1', [scope]); await db.execute('DELETE FROM "foodAiBudget" WHERE scope = $1', [scope]); }
  for (const user of users) await db.execute('DELETE FROM "user" WHERE id = $1', [user.id]);
  await db.end();
});
test("welcome credits are granted once, members see only their wallet, and inputs cannot set signup balances or rates", async () => {
  for (let index = 0; index < 2; index++) {
    const result = await fetch(base + "/api/credits" + (index ? "?userId=" + users[0].id : ""), { headers: { Cookie: users[0].cookie } });
    assert.equal(result.status, 200);
    const wallet = await result.json();
    assert.equal(wallet.balance, 20); assert.equal(wallet.available, 20); assert.equal("multiplier" in wallet, false); assert.equal("maximumReplyCharge" in wallet, false); assert.equal(wallet.canSend, true);
    assert.equal(wallet.transactions.filter((row: { kind: string }) => row.kind === "welcome").length, 1);
    assert.equal(wallet.transactions.find((row: { kind: string }) => row.kind === "welcome").amount, creditSettings().welcomeCents / 100);
    assert.ok(wallet.estimatedReplies > 0);
  }
  assert.equal((await fetch(base + "/api/credits")).status, 401);
  assert.equal((await fetch(base + "/api/credits?userId=" + users[2].id, { headers: { Cookie: users[0].cookie } })).status, 403);
  assert.equal((await post(operation(), users[0].cookie)).status, 403);
  assert.equal((await post(operation(), "")).status, 401);
  assert.equal((await post(operation(), users[1].cookie, "https://outside.example")).status, 403);
  assert.equal(creditCharge(1500, 10000, 200), 30);
  assert.equal(creditCharge(1, 10000, 200), 1);
});
test("admin top-ups and refunds are audited and idempotent; changing an operation requires a new confirmation", async () => {
  const input = operation();
  const results = await Promise.all([post(input), post(input)]);
  assert.ok(results.every(response => response.status === 200));
  const wallet = await getCreditDetails(users[0].id);
  assert.equal(wallet.balance, 70);
  assert.equal(wallet.transactions.filter(item => item.kind === "topup").length, 1);
  assert.equal(wallet.transactions.find(item => item.kind === "topup")!.amountPaid, 50);
  assert.equal((await post({ ...input, amount: 100 })).status, 409);
  assert.equal((await post(operation({ amount: .001 }))).status, 400);
  assert.equal((await post(operation({ action: ["topup"] }))).status, 400);
  assert.equal((await post(operation({ action: "pricing", multiplier: 0 }))).status, 400);
  assert.equal((await post(operation({ action: "pricing", multiplier: 11 }))).status, 400);
  assert.equal((await post(operation({ action: "refund", amount: 5, amountPaid: null, reason: "Correction" }))).status, 200);
  assert.equal((await getCreditDetails(users[0].id)).balance, 75);
  await administerCredits(users[1].id, operation({ action: "pricing", multiplier: 3, reason: "Private multiplier note" }));
  const publicWallet = await (await fetch(base + "/api/credits", { headers: { Cookie: users[0].cookie } })).json();
  assert.equal("multiplier" in publicWallet, false);
  assert.equal(publicWallet.transactions.some((item: { kind: string }) => item.kind === "pricing"), false);
  assert.equal(JSON.stringify(publicWallet).includes("Private multiplier note"), false);
  assert.ok(publicWallet.transactions.every((item: object) => !("multiplier" in item) && !("amountPaid" in item)));
  const adminWallet = await (await fetch(base + "/api/credits?userId=" + users[0].id, { headers: { Cookie: users[1].cookie } })).json();
  assert.equal(adminWallet.multiplier, 3);
  await assert.rejects(administerCredits(users[0].id, operation()), error => error instanceof CreditError && error.status === 403);
});
test("a pending reply holds credits and settles at its original rate even after an admin rate change", async () => {
  const settings = config(), key = hash(); let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  const pending = run(settings, async (...args) => { started(); await held; return reply(...args); }, key);
  await ready;
  try {
    const wallet = await getCreditDetails(users[0].id);
    assert.equal(wallet.balance, 20); assert.equal(wallet.held, 2); assert.equal(wallet.available, 18);
    await administerCredits(users[1].id, operation({ action: "pricing", multiplier: 4 }));
    assert.equal((await getCreditDetails(users[0].id)).multiplier, 4);
  } finally { release(); }
  const first = await pending;
  assert.equal(first.quota.credits!.balance, 19.7);
  assert.equal((await getCreditDetails(users[0].id)).held, 0);
  assert.equal("multiplier" in first.quota.credits!, false);
  const cached = await run(settings, async () => { throw new Error("Cached retry must not call provider"); }, key);
  assert.equal(cached.cached, true); assert.equal(cached.quota.credits!.balance, 19.7);
  await run(settings);
  const wallet = await getCreditDetails(users[0].id);
  assert.equal(wallet.balance, 19.1);
  assert.deepEqual(wallet.transactions.filter(item => item.kind === "usage").map(item => item.multiplier).sort(), [2, 4]);
});
test("insufficient credits stop calls before billing and concurrent holds cannot overspend", async () => {
  const settings = config(); let called = false;
  await db.execute('UPDATE "creditWallet" SET "balanceCents" = 199 WHERE "userId" = $1', [users[0].id]);
  await assert.rejects(run(settings, async () => { called = true; return reply(""); }), error => error instanceof FoodAiError && error.code === "AI_CREDITS");
  assert.equal(called, false);
  await db.execute('UPDATE "creditWallet" SET "balanceCents" = 200 WHERE "userId" = $1', [users[0].id]);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  const first = run(settings, async (...args) => { started(); await held; return reply(...args); }); await ready;
  try {
    const results = await Promise.allSettled([run(settings), run(settings)]);
    assert.ok(results.every(result => result.status === "rejected" && result.reason.code === "AI_CREDITS"));
    assert.equal((await getCreditDetails(users[0].id)).available, 0);
  } finally { release(); }
  await first;
  const wallet = await getCreditDetails(users[0].id);
  assert.equal(wallet.balance, 1.7); assert.equal(wallet.held, 0); assert.equal(wallet.estimatedReplies, 0);
});
test("failed, rejected and unmetered replies release holds without charging users while retaining provider costs", async () => {
  const settings = config();
  await assert.rejects(run(settings, async () => new Response("private failure", { status: 503 })));
  await assert.rejects(run(settings, async () => Response.json({ candidates: [{ finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 500 } })));
  await requestFoodAi(users[0].id, hash(), {}, value => value, { settings, fetcher: reply }, () => true);
  await run(settings, async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"ok":true}' }] } }] }));
  const wallet = await getCreditDetails(users[0].id);
  assert.equal(wallet.balance, 20); assert.equal(wallet.held, 0);
  assert.ok(wallet.transactions.filter(item => item.kind === "usage").every(item => item.amount === 0));
  const [cost] = await db.execute<DatabaseRow[]>('SELECT SUM("costMicros") AS total FROM "foodAiUsage" WHERE scope = $1', [settings.scope]);
  assert.ok(Number(cost[0].total) > 0);
});
test("abandoned holds expire once and a late settlement cannot charge released credits", async () => {
  const settings = config(), usageId = randomUUID();
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const reserved = await reserveCredits(connection, users[0].id);
    await connection.execute('INSERT INTO "foodAiBudget" (scope, month) VALUES ($1, $2)', [settings.scope, "2026-01"]);
    await connection.execute(`INSERT INTO "foodAiUsage" (id, scope, "budgetMonth", "userId", "imageHash", status, "costMicros", "createdAt", "creditReservedCents", "creditHoldActive", "creditMultiplierHundred", "creditFxCents")
      VALUES ($1, $2, '2026-01', $3, $4, 'pending', 10000, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '6 minutes', $5, TRUE, $6, $7)`, [usageId, settings.scope, users[0].id, hash(), reserved.cents, reserved.multiplierHundred, reserved.fxCents]);
    await connection.commit();
  } finally { connection.release(); }
  assert.equal((await getCreditDetails(users[0].id)).held, 0);
  const settlement = await db.getConnection();
  try {
    await settlement.beginTransaction();
    await settleCredits(settlement, users[0].id, usageId, 1500, true, "Late reply");
    await settleCredits(settlement, users[0].id, usageId, 1500, true, "Duplicate late reply");
    await settlement.commit();
  } finally { settlement.release(); }
  assert.equal((await getCreditDetails(users[0].id)).balance, 20);
});
test("user charges cannot exceed the reserved maximum and global budget limits still apply", async () => {
  const settings = config();
  await run(settings, async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 200000, candidatesTokenCount: 0 } }));
  assert.equal((await getCreditDetails(users[0].id)).balance, 18);
  await assert.rejects(run({ ...config(), monthlyBudgetMicros: 0 }), error => error instanceof FoodAiError && error.code === "AI_MONTHLY_LIMIT");
  assert.equal((await getCreditDetails(users[0].id)).held, 0);
});

test("an undeliverable reply creates one compensating refund without deleting the original charge", async () => {
  const settings = config(), first = await run(settings);
  assert.equal((await getCreditDetails(users[0].id)).balance, 19.7);
  await Promise.all([refundUndeliveredReply(users[0].id, first.analysisId), refundUndeliveredReply(users[0].id, first.analysisId)]);
  const wallet = await getCreditDetails(users[0].id);
  assert.equal(wallet.balance, 20);
  assert.equal(wallet.transactions.filter(item => item.kind === "usage").length, 1);
  assert.equal(wallet.transactions.filter(item => item.kind === "refund").length, 1);
});

test("signup default configuration validates rates and migration preserves existing balances and custom rates", async () => {
  const oldWelcome = process.env.AI_WELCOME_CREDITS, oldRate = process.env.AI_DEFAULT_MULTIPLIER;
  const connection = await db.getConnection();
  try {
    delete process.env.AI_WELCOME_CREDITS; delete process.env.AI_DEFAULT_MULTIPLIER;
    assert.equal(creditSettings().welcomeCents, 5000);
    assert.equal(creditSettings().defaultMultiplierHundred, 333);
    process.env.AI_WELCOME_CREDITS = "75"; process.env.AI_DEFAULT_MULTIPLIER = "4.25";
    assert.equal(creditSettings().welcomeCents, 7500);
    assert.equal(creditSettings().defaultMultiplierHundred, 425);
    for (const value of ["0", "10.01", "3.333", "invalid"]) {
      process.env.AI_DEFAULT_MULTIPLIER = value;
      assert.throws(() => creditSettings(), CreditError);
    }
    process.env.AI_DEFAULT_MULTIPLIER = "4.25";
    await connection.beginTransaction();
    await migrateCredits(connection);
    const [rows] = await connection.execute<DatabaseRow[]>('SELECT "balanceCents", "multiplierHundred" FROM "creditWallet" WHERE "userId" = $1', [users[0].id]);
    assert.equal(Number(rows[0].balanceCents), 2000);
    assert.equal(rows[0].multiplierHundred, 200);
    const [ledger] = await connection.execute<DatabaseRow[]>('SELECT COUNT(*)::integer AS count FROM "creditLedger" WHERE "userId" = $1 AND kind = \'welcome\'', [users[0].id]);
    assert.equal(ledger[0].count, 1);
    const freshId = randomUUID();
    await connection.execute(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES ($1, 'Defaults fixture', $2, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [freshId, `defaults-${freshId}@example.com`]);
    const [fresh] = await connection.execute<DatabaseRow[]>('SELECT "balanceCents", "multiplierHundred" FROM "creditWallet" WHERE "userId" = $1', [freshId]);
    assert.equal(Number(fresh[0].balanceCents), 7500);
    assert.equal(fresh[0].multiplierHundred, 425);
    // Roll back the temporary defaults so other signup tests keep their configured settings.
    await connection.rollback();
  } finally {
    if (oldWelcome === undefined) delete process.env.AI_WELCOME_CREDITS; else process.env.AI_WELCOME_CREDITS = oldWelcome;
    if (oldRate === undefined) delete process.env.AI_DEFAULT_MULTIPLIER; else process.env.AI_DEFAULT_MULTIPLIER = oldRate;
    await connection.rollback(); connection.release();
  }
});

test("members see additions before the history limit while admin keeps usage and pricing audit entries", async () => {
  await administerCredits(users[1].id, operation({ amount: 10 }));
  await administerCredits(users[1].id, operation({ action: "refund", amount: 2 }));
  await administerCredits(users[1].id, operation({ action: "pricing", multiplier: 3.33 }));
  await db.execute(`INSERT INTO "creditLedger" (id, "userId", kind, "amountCents", "balanceAfterCents", reason, "createdAt")
    SELECT gen_random_uuid()::text, $1, 'usage', CASE WHEN n % 2 = 0 THEN -10 ELSE 0 END, 3200,
      'Private AI usage fixture', CURRENT_TIMESTAMP + INTERVAL '1 minute' FROM generate_series(1, 35) n`, [users[0].id]);
  const member = await (await fetch(base + "/api/credits", { headers: { Cookie: users[0].cookie } })).json();
  assert.deepEqual(member.transactions.map((item: { kind: string }) => item.kind).sort(), ["refund", "topup", "welcome"]);
  assert.ok(member.transactions.every((item: { amount: number }) => item.amount > 0));
  assert.equal(JSON.stringify(member).includes("Private AI usage fixture"), false);
  const admin = await (await fetch(base + "/api/credits?userId=" + users[0].id, { headers: { Cookie: users[1].cookie } })).json();
  assert.equal(admin.transactions.length, 30);
  assert.ok(admin.transactions.some((item: { kind: string; amount: number }) => item.kind === "usage" && item.amount < 0));
  assert.equal(admin.balance, member.balance);
});
