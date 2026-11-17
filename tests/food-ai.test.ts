import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { DatabaseRow } from "../src/lib/db";
import { db } from "../src/lib/db";
import { analyzeFoodPhoto, foodAiStatus, normalizeFoodPhoto, FoodAiError, FOOD_AI_MODEL, type FoodAiSettings } from "../src/lib/food-ai";
import { macroCalorieEstimate } from "../src/lib/food";

const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const users: { id: string; cookie: string }[] = [];
const scopes: string[] = [];
let photo: Buffer;
const meal = { isFood: true, name: "Dal and rice", calories: 430, fat: 10, protein: 15, carbs: 70, assumptions: "One bowl each of dal and rice, including cooking oil." };
function settings(overrides: Partial<FoodAiSettings> = {}): FoodAiSettings {
  const scope = "ai-test-" + randomUUID(); scopes.push(scope);
  return { apiKey: "test-secret-never-a-real-key", scope, globalDailyLimit: 50, monthlyBudgetMicros: 1_000_000, ...overrides };
}
function provider(value: unknown = meal, finishReason = "STOP"): typeof fetch {
  return async () => Response.json({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 20 } });
}
const code = (expected: string) => (error: unknown) => error instanceof FoodAiError && error.code === expected;
async function rows(scope: string) {
  const [result] = await db.execute<DatabaseRow[]>("SELECT * FROM \"foodAiUsage\" WHERE scope = $1", [scope]); return result;
}
function foodRequest(user: number, body: object, method = "POST") {
  return fetch(base + "/api/food", { method, headers: { Origin: base, Cookie: users[user].cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

before(async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname));
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  photo = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#86aa6b" } }).png().toBuffer();
  for (let index = 0; index < 2; index++) {
    const response = await fetch(base + "/api/auth/sign-up/email", { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-Forwarded-For": `198.15.${Math.floor(Math.random() * 240) + 1}.${index + 1}` }, body: JSON.stringify({ name: "AI fixture", email: `ai-${randomUUID()}@example.com`, password: "AI-fixture-" + randomUUID() }) });
    assert.equal(response.status, 200);
    users.push({ id: (await response.json()).user.id, cookie: response.headers.getSetCookie().map(item => item.split(";")[0]).join("; ") });
  }
});
after(async () => {
  for (const scope of scopes) {
    await db.execute("DELETE FROM \"foodAiUsage\" WHERE scope = $1", [scope]);
    await db.execute("DELETE FROM \"foodAiBudget\" WHERE scope = $1", [scope]);
  }
  for (const user of users) {
    await db.execute("DELETE FROM \"session\" WHERE \"userId\" = $1", [user.id]);
    await db.execute("DELETE FROM \"account\" WHERE \"userId\" = $1", [user.id]);
    await db.execute("DELETE FROM \"user\" WHERE id = $1", [user.id]);
  }
  await db.end();
});

test("photos are decoded, resized, stripped of metadata, and rejected before charging when invalid", async () => {
  const original = await sharp(photo).withExif({ IFD0: { Artist: "Private fixture" } }).png().toBuffer();
  const normalized = await normalizeFoodPhoto(original);
  const metadata = await sharp(normalized).metadata();
  assert.equal(metadata.format, "jpeg"); assert.equal(metadata.width, 1024); assert.equal(metadata.exif, undefined);
  const config = settings(); let called = false;
  const fetcher: typeof fetch = async () => { called = true; throw new Error("Unexpected call"); };
  await assert.rejects(analyzeFoodPhoto(users[0].id, Buffer.from("not an image"), "", { settings: config, fetcher }), code("PHOTO_FORMAT"));
  await assert.rejects(analyzeFoodPhoto(users[0].id, Buffer.alloc(1024 * 1024 + 1), "", { settings: config, fetcher }), code("PHOTO_SIZE"));
  await assert.rejects(analyzeFoodPhoto(users[0].id, photo, "x".repeat(301), { settings: config, fetcher }), code("PHOTO_NOTE"));
  await assert.rejects(analyzeFoodPhoto(users[0].id, photo, "", { settings: { ...config, apiKey: "" }, fetcher }), code("AI_NOT_CONFIGURED"));
  assert.equal(called, false); assert.equal((await rows(config.scope)).length, 0);
});

test("structured estimates use bounded Gemini requests, settle usage, cache per owner, and never auto-log", async () => {
  const config = settings(); let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${FOOD_AI_MODEL}:generateContent`);
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), config.apiKey);
    const body = JSON.parse(init!.body as string);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal(body.generationConfig.maxOutputTokens, 768);
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "MINIMAL");
    assert.ok(body.generationConfig.responseJsonSchema.required.includes("fat"));
    assert.equal(body.contents[0].parts[0].text, "Portion note: I ate half");
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, "image/jpeg");
    return provider()(url, init);
  };
  const first = await analyzeFoodPhoto(users[0].id, photo, " I ate half ", { settings: config, fetcher });
  assert.equal(first.draft.calories, 430); assert.equal(first.cached, false); assert.equal(first.quota.remainingToday, 49);
  assert.equal(JSON.stringify(first).includes(config.apiKey), false);
  const again = await analyzeFoodPhoto(users[0].id, photo, "I ate half", { settings: config, fetcher });
  assert.equal(again.draft.analysisId, first.draft.analysisId); assert.equal(again.cached, true); assert.equal(calls, 1);
  const ledger = await rows(config.scope);
  assert.equal(Number(ledger[0].costMicros), 430); // 1,000 input × .25 + 120 output × 1.5.
  assert.equal(Number(ledger[0].outputTokens), 120); assert.equal(ledger[0].status, "succeeded");
  const [count] = await db.execute<DatabaseRow[]>("SELECT COUNT(*)::integer AS total FROM \"foodEntry\" WHERE \"userId\" = $1", [users[0].id]);
  assert.equal(Number(count[0].total), 0);
  const other = await analyzeFoodPhoto(users[1].id, photo, "I ate half", { settings: config, fetcher });
  assert.notEqual(other.draft.analysisId, first.draft.analysisId); assert.equal(calls, 2);
  await db.execute("UPDATE \"foodAiUsage\" SET \"cacheExpiresAt\" = ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 second') WHERE id = $1", [first.draft.analysisId]);
  const refreshed = await analyzeFoodPhoto(users[0].id, photo, "I ate half", { settings: config, fetcher });
  assert.notEqual(refreshed.draft.analysisId, first.draft.analysisId); assert.equal(calls, 3);
});

test("no-food responses are cached as rejection and malformed or incomplete estimates cannot become drafts", async () => {
  const config = settings(); let calls = 0;
  const fetcher: typeof fetch = async (...args) => { calls++; return provider({ isFood: false })(...args); };
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(analyzeFoodPhoto(users[0].id, photo, "", { settings: config, fetcher }), code("NO_FOOD"));
  assert.equal(calls, 1); assert.equal((await rows(config.scope))[0].status, "rejected");
  for (const [value, finish] of [[{ ...meal, fat: null }, "STOP"], [{ ...meal, calories: -5 }, "STOP"], [meal, "MAX_TOKENS"]] as const) {
    const invalidConfig = settings();
    await assert.rejects(analyzeFoodPhoto(users[0].id, photo, "", { settings: invalidConfig, fetcher: provider(value, finish) }), code("AI_INVALID_RESPONSE"));
    assert.equal((await rows(invalidConfig.scope))[0].status, "failed");
  }
});

test("provider failures and cancellation consume a conservative allowance without exposing provider errors", async () => {
  const config = settings();
  await assert.rejects(analyzeFoodPhoto(users[0].id, photo, "", { settings: config, fetcher: async () => new Response("SECRET provider diagnostic", { status: 403 }) }), error => code("AI_PROVIDER_AUTH")(error) && !(error as Error).message.includes("SECRET"));
  assert.equal(Number((await rows(config.scope))[0].costMicros), 10_000);
  assert.equal((await foodAiStatus(users[0].id, config)).remainingToday, 49);
  await assert.rejects(analyzeFoodPhoto(users[0].id, photo, "retry", { settings: config, fetcher: async () => { throw new DOMException("cancel", "AbortError"); } }), code("AI_TIMEOUT"));
  assert.equal((await rows(config.scope)).length, 2);
  assert.equal((await foodAiStatus(users[0].id, config)).remainingBudgetUsd, .98);
});

test("daily allowances are shared atomically and cache hits do not spend another attempt", async () => {
  const config = settings({ globalDailyLimit: 2 });
  await analyzeFoodPhoto(users[0].id, photo, "", { settings: config, fetcher: provider() });
  await analyzeFoodPhoto(users[0].id, photo, "", { settings: config, fetcher: provider() });
  await analyzeFoodPhoto(users[0].id, photo, "different", { settings: config, fetcher: provider() });
  await analyzeFoodPhoto(users[0].id, photo, "", { settings: config, fetcher: provider() }); // Cached even after the shared limit is reached.
  assert.equal((await foodAiStatus(users[1].id, config)).remainingToday, 0);
  await assert.rejects(analyzeFoodPhoto(users[1].id, photo, "different", { settings: config, fetcher: provider() }), code("AI_DAILY_LIMIT"));
});

test("credit-funded users can exceed the former ten-reply daily cap", async () => {
  const config = settings({ globalDailyLimit: 50 }); let calls = 0;
  const fetcher: typeof fetch = async (...args) => { calls++; return provider()(...args); };
  for (let index = 0; index < 11; index++) await analyzeFoodPhoto(users[0].id, photo, "Daily-cap regression " + index, { settings: config, fetcher });
  const status = await foodAiStatus(users[0].id, config);
  assert.equal(calls, 11); assert.equal(status.remainingToday, 39);
  assert.ok(status.credits!.available > 0); assert.equal(status.credits!.canSend, true);
});

test("concurrent requests reserve the budget before calling Google and deduplicate pending photos", async () => {
  const config = settings({ monthlyBudgetMicros: 10_000 });
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const first = analyzeFoodPhoto(users[0].id, photo, "", { settings: config, fetcher: async (...args) => { started(); await held; return provider()(...args); } });
  await ready;
  try {
    await assert.rejects(analyzeFoodPhoto(users[0].id, photo, "", { settings: config, fetcher: provider() }), code("AI_PENDING"));
    await assert.rejects(analyzeFoodPhoto(users[1].id, photo, "other", { settings: config, fetcher: provider() }), code("AI_MONTHLY_LIMIT"));
    assert.equal((await rows(config.scope)).length, 1);
  } finally { release(); await first; }
  assert.equal((await foodAiStatus(users[0].id, config)).remainingBudgetUsd, .00957);
});

test("simultaneous new requests cannot exceed the shared daily allowance", async () => {
  const config = settings({ globalDailyLimit: 1 }); let calls = 0;
  const fetcher: typeof fetch = async (...args) => { calls++; return provider()(...args); };
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => analyzeFoodPhoto(users[index % 2].id, photo, "portion " + index, { settings: config, fetcher })));
  assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
  for (const attempt of attempts) if (attempt.status === "rejected") assert.ok(code("AI_DAILY_LIMIT")(attempt.reason));
  assert.equal(calls, 1); assert.equal((await rows(config.scope)).length, 1);
});

test("saved photo estimates are owner-scoped and remain editable", async () => {
  const estimate = await analyzeFoodPhoto(users[0].id, photo, "", { settings: settings(), fetcher: provider() });
  const food = { ...estimate.draft, eatenAtLocal: "2036-01-01T12:00", timeZone: "UTC" };
  assert.equal((await foodRequest(1, food)).status, 400);
  const saved = await foodRequest(0, food); assert.equal(saved.status, 201);
  const id = (await saved.json()).id;
  assert.equal((await foodRequest(0, { id, calories: 500 }, "PATCH")).status, 200);
  const [entries] = await db.execute<DatabaseRow[]>("SELECT calories, category, \"analysisId\" FROM \"foodEntry\" WHERE id = $1", [id]);
  assert.equal(Number(entries[0].calories), 500); assert.equal(entries[0].category, "healthy");
  assert.equal(entries[0].analysisId, estimate.draft.analysisId);
  assert.equal((await foodRequest(0, { id }, "DELETE")).status, 200);
});

test("analysis endpoints require authentication and trusted origins, with a safe unconfigured state", async () => {
  assert.equal((await fetch(base + "/api/food/analyze")).status, 401);
  assert.equal((await fetch(base + "/api/food/analyze", { method: "POST" })).status, 401);
  assert.equal((await fetch(base + "/api/food/analyze", { method: "POST", headers: { Cookie: users[0].cookie, Origin: "https://other.example" } })).status, 403);
  const status = await fetch(base + "/api/food/analyze", { headers: { Cookie: users[0].cookie } });
  assert.equal(status.status, 200); assert.equal(status.headers.get("cache-control"), "no-store");
  const body = await status.json(); assert.equal(typeof body.configured, "boolean");
  if (!body.configured) assert.equal((await fetch(base + "/api/food/analyze", { method: "POST", headers: { Cookie: users[0].cookie, Origin: base } })).status, 503);
});

test("macro mismatch is a warning threshold rather than a required exact match", () => {
  assert.equal(macroCalorieEstimate({ calories: 400, fat: 10, protein: 20, carbs: 50 }), null);
  assert.equal(macroCalorieEstimate({ calories: 800, fat: 10, protein: 20, carbs: 50 }), 370);
  assert.equal(macroCalorieEstimate({ calories: 0, fat: 0, protein: 0, carbs: 0 }), null);
});
