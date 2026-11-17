import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { DatabaseRow } from "../src/lib/db";
import { db } from "../src/lib/db";
import { confirmFoodChat, getFoodChat, sendFoodChat, resetFoodChat } from "../src/lib/food-chat";
import { FoodAiError, type FoodAiOptions, type FoodAiSettings } from "../src/lib/food-ai";
import { MAX_CHAT_PHOTO_BYTES, MAX_CHAT_PHOTOS, parseFood } from "../src/lib/food";

const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const users: { id: string; cookie: string }[] = [], scopes: string[] = [];
const meal = { name: "Poha and chai", calories: 360, fat: 12, protein: 9, carbs: 54, meal: "breakfast", category: "healthy", eatenAtLocal: parseFood({ calories: 0, fat: 0, protein: 0, carbs: 0, timeZone: "Asia/Kolkata" }).eatenAtLocal, assumptions: "One bowl of poha and one cup of chai.", targetEntryId: null };
const code = (value: string) => (error: unknown) => error instanceof FoodAiError && error.code === value;
function config(): FoodAiSettings { const scope = "chat-test-" + randomUUID(); scopes.push(scope); return { scope, apiKey: "fake-key", userDailyLimit: 100, globalDailyLimit: 100, monthlyBudgetMicros: 1_000_000 }; }
function mock(value: unknown = { intent: "draft", reply: "Here is your meal estimate. Review it before logging.", draft: meal }): typeof fetch {
  return async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } });
}
async function send(user: number, text: string, options: FoodAiOptions, extra: Record<string, unknown> = {}) {
  const state = await getFoodChat(users[user].id, options);
  return sendFoodChat(users[user].id, { requestId: randomUUID(), version: state.version, text, timeZone: "Asia/Kolkata", ...extra }, options);
}
async function reset(user = 0) { await db.execute("DELETE FROM \"foodEntry\" WHERE \"userId\" = $1", [users[user].id]); await db.execute("DELETE FROM \"foodChat\" WHERE \"userId\" = $1", [users[user].id]); }
async function foods(user = 0) { const [rows] = await db.execute<DatabaseRow[]>("SELECT * FROM \"foodEntry\" WHERE \"userId\" = $1", [users[user].id]); return rows; }

before(async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname));
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + "/api/auth/sign-up/email", { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-Forwarded-For": `198.14.${Math.floor(Math.random() * 240) + 1}.${i + 1}` }, body: JSON.stringify({ name: "Chat fixture", email: `chat-${randomUUID()}@example.com`, password: randomUUID() + "-Chat!" }) });
    assert.equal(response.status, 200);
    users.push({ id: (await response.json()).user.id, cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") });
  }
});
after(async () => {
  for (const scope of scopes) { await db.execute("DELETE FROM \"foodAiUsage\" WHERE scope = $1", [scope]); await db.execute("DELETE FROM \"foodAiBudget\" WHERE scope = $1", [scope]); }
  for (const user of users) {
    await db.execute("DELETE FROM \"session\" WHERE \"userId\" = $1", [user.id]); await db.execute("DELETE FROM \"account\" WHERE \"userId\" = $1", [user.id]); await db.execute("DELETE FROM \"user\" WHERE id = $1", [user.id]);
  }
  await db.end();
});

test("chat drafts persist privately, follow-ups see the current draft, and sending never logs a meal", async () => {
  await reset(); const settings = config(); let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++; const body = JSON.parse(init!.body as string), prompt = body.contents[0].parts[0].text;
    assert.equal(body.generationConfig.maxOutputTokens, 1024);
    assert.ok(body.systemInstruction.parts[0].text.includes("You are Kay"));
    assert.ok(body.systemInstruction.parts[0].text.includes("New meals default category=healthy"));
    assert.ok(!prompt.includes(users[1].id));
    if (calls === 2) { assert.ok(prompt.includes('"calories":360')); assert.ok(prompt.includes("I ate half")); assert.ok(prompt.includes("recentMessages")); }
    return mock({ intent: "draft", reply: calls === 1 ? "Review your meal." : "Updated to half a portion.", draft: { ...meal, calories: calls === 1 ? 360 : 180, fat: calls === 1 ? 12 : 6, protein: calls === 1 ? 9 : 4.5, carbs: calls === 1 ? 54 : 27 } })(url, init);
  };
  const options = { settings, fetcher };
  const first = await send(0, "I had poha and chai", options);
  assert.equal(first.messages.length, 2); assert.equal(first.draft!.category, "healthy"); assert.equal((await foods()).length, 0);
  const second = await send(0, "I ate half", options);
  assert.equal(second.messages.length, 4); assert.equal(second.draft!.calories, 180);
  assert.equal(second.messages.find(message => message.id === first.draft!.draftId)!.payload.state, "superseded");
  await assert.rejects(confirmFoodChat(users[0].id, first.draft!.draftId, first.draft, options), code("CHAT_DRAFT_CHANGED"));
  const reloaded = await getFoodChat(users[0].id, options);
  assert.equal(reloaded.draft!.draftId, second.draft!.draftId); assert.equal(reloaded.messages[0].content, "I had poha and chai");
  const other = await getFoodChat(users[1].id, options); assert.equal(other.messages.length, 0); assert.equal(other.draft, null);
  await assert.rejects(confirmFoodChat(users[1].id, second.draft!.draftId, second.draft, options), code("CHAT_DRAFT"));
});

test("confirm is atomic, idempotent under simultaneous saves, and can be corrected through chat", async () => {
  await reset(); const options = { settings: config(), fetcher: mock() };
  const draft = (await send(0, "Log breakfast", options)).draft!;
  const confirmed = await Promise.all([confirmFoodChat(users[0].id, draft.draftId, draft, options), confirmFoodChat(users[0].id, draft.draftId, draft, options)]);
  assert.ok(confirmed.every(state => state.draft === null)); assert.equal((await foods()).length, 1);
  const entryId = (await foods())[0].id;
  assert.equal((await foods())[0].chatMessageId, draft.draftId);
  const correction = await send(0, "Actually it was half", { ...options, fetcher: mock({ intent: "draft", reply: "Review the correction.", draft: { ...meal, calories: 180, targetEntryId: entryId } }) });
  await confirmFoodChat(users[0].id, correction.draft!.draftId, correction.draft, options);
  assert.equal((await foods()).length, 1); assert.equal(Number((await foods())[0].calories), 180);
  // A delayed retry of the original confirmation cannot revert the later correction.
  await confirmFoodChat(users[0].id, draft.draftId, draft, options);
  assert.equal(Number((await foods())[0].calories), 180);
});

test("manual edits and deletion invalidate pending corrections rather than overwriting current records", async () => {
  await reset(); const options = { settings: config(), fetcher: mock() };
  const first = (await send(0, "Breakfast", options)).draft!;
  await confirmFoodChat(users[0].id, first.draftId, first, options);
  const id = (await foods())[0].id;
  const correction = (await send(0, "Correct breakfast", { ...options, fetcher: mock({ intent: "draft", reply: "Review this.", draft: { ...meal, targetEntryId: id } }) })).draft!;
  await db.execute("UPDATE \"foodEntry\" SET calories = 999 WHERE id = $1", [id]);
  await assert.rejects(confirmFoodChat(users[0].id, correction.draftId, correction, options), code("CHAT_ENTRY_CHANGED"));
  assert.equal(Number((await foods())[0].calories), 999);
  await db.execute("DELETE FROM \"foodEntry\" WHERE id = $1", [id]);
  await assert.rejects(confirmFoodChat(users[0].id, correction.draftId, correction, options), code("CHAT_ENTRY_MISSING"));
});

test("ambiguous conversation creates no draft; summaries use owned saved totals and exclude drafts", async () => {
  await reset(); const options = { settings: config(), fetcher: mock({ intent: "reply", reply: "What did you eat, and roughly how much?", draft: null }) };
  const clarify = await send(0, "I had some food", options); assert.equal(clarify.draft, null);
  const draft = (await send(0, "Poha and chai", { ...options, fetcher: mock() })).draft!;
  const summary = await send(0, "How many calories today?", { ...options, fetcher: mock({ intent: "summary", reply: "These are today’s saved totals.", draft: null }) });
  assert.equal(summary.messages.at(-1)!.payload.summary!.calories, 0);
  assert.equal(summary.draft!.draftId, draft.draftId);
  const discarded = await send(0, "Forget that meal", { ...options, fetcher: mock({ intent: "discard", reply: "The draft is cleared.", draft: null }) });
  assert.equal(discarded.draft, null); assert.equal((await foods()).length, 0);
});

test("photos use one bounded request, invalid output cannot save, and failed requests can be explicitly retried", async () => {
  await reset(); const settings = config(); const photo = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#aac488" } }).png().toBuffer();
  const options = { settings, fetcher: (async (url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, "image/jpeg");
    const meta = await sharp(Buffer.from(body.contents[0].parts[1].inlineData.data, "base64")).metadata(); assert.equal(meta.width, 1024);
    return mock()(url, init);
  }) as typeof fetch };
  await send(0, "", options, { photos: [photo] });
  const state = await getFoodChat(users[0].id, options), id = randomUUID();
  const input = { requestId: id, version: state.version, text: "I ate half", timeZone: "Asia/Kolkata" };
  await assert.rejects(sendFoodChat(users[0].id, input, { settings, fetcher: mock({ intent: "draft", reply: "Oops", draft: { ...meal, fat: -5 } }) }), code("AI_INVALID_RESPONSE"));
  const failed = await getFoodChat(users[0].id, options); assert.equal(failed.pending, false); assert.equal(failed.messages.at(-1)!.payload.state, "failed");
  const retry = await sendFoodChat(users[0].id, { ...input, version: failed.version }, { settings, fetcher: mock() });
  assert.equal(retry.messages.filter(message => message.requestId === id && message.role === "user").length, 1);
  assert.equal(retry.messages.at(-1)!.role, "assistant"); assert.equal((await foods()).length, 0);
  await assert.rejects(send(0, "Change someone else’s meal", { settings, fetcher: mock({ intent: "draft", reply: "No", draft: { ...meal, targetEntryId: randomUUID() } }) }), code("AI_INVALID_RESPONSE"));
});

test("concurrent turns, stale versions, reused request IDs, and expired leases are handled safely", async () => {
  await reset(); const settings = config(); let release!: () => void, start!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { start = resolve; });
  const state = await getFoodChat(users[0].id, { settings });
  const input = { requestId: randomUUID(), version: state.version, text: "Breakfast", timeZone: "UTC" };
  const first = sendFoodChat(users[0].id, input, { settings, fetcher: async (...args) => { start(); await held; return mock()(...args); } });
  await ready;
  try { await assert.rejects(sendFoodChat(users[0].id, { ...input, requestId: randomUUID() }, { settings, fetcher: mock() }), code("CHAT_PENDING")); }
  finally { release(); }
  const completed = await first;
  const replay = await sendFoodChat(users[0].id, input, { settings, fetcher: async () => { throw new Error("must not call"); } });
  assert.equal(replay.messages.length, completed.messages.length);
  await assert.rejects(sendFoodChat(users[0].id, { ...input, text: "changed" }, { settings, fetcher: mock() }), code("CHAT_REQUEST_REUSED"));
  await assert.rejects(sendFoodChat(users[0].id, { ...input, requestId: randomUUID() }, { settings, fetcher: mock() }), code("CHAT_CHANGED"));
  await db.execute("UPDATE \"foodChat\" SET \"pendingToken\" = $1, \"pendingRequestId\" = $2, \"pendingStartedAt\" = ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 minute') WHERE \"userId\" = $3", [randomUUID(), randomUUID(), users[0].id]);
  assert.equal((await getFoodChat(users[0].id, { settings })).pending, false);
});

test("history pagination remains owner scoped", async () => {
  await reset(); const options = { settings: config(), fetcher: mock() };
  const state = await getFoodChat(users[0].id, options);
  for (let index = 0; index < 45; index++) await db.execute("INSERT INTO \"foodChatMessage\" (id, \"chatId\", \"requestId\", role, content, payload, \"createdAt\") VALUES ($1, $2, $3, 'user', $4, $5, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))", [randomUUID(), state.chatId, randomUUID(), "Message " + index, JSON.stringify({ state: "ready" })]);
  const latest = await getFoodChat(users[0].id, options); assert.equal(latest.messages.length, 40); assert.equal(latest.hasMore, true);
  const older = await getFoodChat(users[0].id, options, latest.messages[0].sequence); assert.equal(older.messages.length, 5); assert.equal(older.hasMore, false);
  assert.equal(older.messages[0].content, "Message 0");
  assert.equal((await getFoodChat(users[1].id, options, latest.messages[0].sequence)).messages.length, 0);
});

test("chat HTTP endpoints enforce authentication, origins, body bounds, and owner-scoped confirmation", async () => {
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) assert.equal((await fetch(base + "/api/food/chat", { method })).status, 401);
  const headers = { Cookie: users[0].cookie, Origin: base };
  assert.equal((await fetch(base + "/api/food/chat", { method: "POST", headers: { ...headers, Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await fetch(base + "/api/food/chat", { method: "DELETE", headers: { ...headers, Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await fetch(base + "/api/food/chat?before=invalid", { headers })).status, 400);
  assert.equal((await fetch(base + "/api/food/chat", { method: "POST", headers, body: "wrong format" })).status, 415);
  const oversized = new FormData(); oversized.set("text", "x".repeat(MAX_CHAT_PHOTO_BYTES + 17000));
  assert.equal((await fetch(base + "/api/food/chat", { method: "POST", headers, body: oversized })).status, 413);
  const invalid = new FormData(); invalid.set("version", "0"); invalid.set("requestId", randomUUID()); invalid.set("timeZone", "UTC"); invalid.set("photo", new File(["invalid image bytes"], "invalid.jpg", { type: "image/jpeg" }));
  assert.equal((await fetch(base + "/api/food/chat", { method: "POST", headers, body: invalid })).status, 400);
  const tooMany = new FormData(); tooMany.set("text", "Food"); tooMany.set("version", "0"); tooMany.set("requestId", randomUUID()); tooMany.set("timeZone", "UTC");
  for (let index = 0; index < MAX_CHAT_PHOTOS + 1; index++) tooMany.append("photos", new File(["tiny"], `photo-${index}.jpg`, { type: "image/jpeg" }));
  assert.equal((await fetch(base + "/api/food/chat", { method: "POST", headers, body: tooMany })).status, 400);
  const invalidBatch = new FormData(); invalidBatch.set("text", "Food"); invalidBatch.set("version", "0"); invalidBatch.set("requestId", randomUUID()); invalidBatch.set("timeZone", "UTC");
  invalidBatch.append("photos", new File(["not an image"], "bad.jpg", { type: "image/jpeg" }));
  invalidBatch.append("photos", "not a file");
  assert.equal((await fetch(base + "/api/food/chat", { method: "POST", headers, body: invalidBatch })).status, 400);
  await reset(); const options = { settings: config(), fetcher: mock() };
  const draft = (await send(0, "Breakfast", options)).draft!;
  const other = await fetch(base + "/api/food/chat", { method: "PATCH", headers: { ...headers, Cookie: users[1].cookie, "Content-Type": "application/json" }, body: JSON.stringify({ draftId: draft.draftId, food: draft }) });
  assert.equal(other.status, 404);
  const own = await fetch(base + "/api/food/chat", { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ draftId: draft.draftId, food: draft }) });
  assert.equal(own.status, 200); assert.equal((await foods()).length, 1);
  assert.equal((await fetch(base + "/api/food/chat", { headers })).headers.get("cache-control"), "no-store");
});

test("multiple dishes share one AI call and one meal draft, with image-bound retries and persisted counts", async () => {
  await reset(); const settings = config(); let calls = 0;
  const photos = await Promise.all(["#bb7766", "#99aa66", "#aabbcc"].map(background => sharp({ create: { width: 1300, height: 900, channels: 3, background } }).png().toBuffer()));
  const fetcher: typeof fetch = async (url, init) => {
    calls++; const body = JSON.parse(init!.body as string), parts = body.contents[0].parts;
    assert.equal(parts.length, 4);
    assert.ok(parts[0].text.includes('"mode":"meal"'));
    assert.ok(parts[0].text.includes('"attachedCount":3'));
    assert.ok(body.systemInstruction.parts[0].text.includes("Photo count is not serving count"));
    assert.ok(body.systemInstruction.parts[0].text.includes("ask a short clarification"));
    for (const part of parts.slice(1)) {
      assert.equal(part.inlineData.mimeType, "image/jpeg");
      const image = await sharp(Buffer.from(part.inlineData.data, "base64")).metadata();
      assert.equal(image.width, 1024); assert.equal(image.exif, undefined);
    }
    return mock()(url, init);
  };
  const options = { settings, fetcher }, initial = await getFoodChat(users[0].id, options);
  const input = { requestId: randomUUID(), version: initial.version, text: "These are the different dishes I ate together", timeZone: "Asia/Kolkata", photos, photoMode: "meal" as const };
  const draft = await sendFoodChat(users[0].id, input, options);
  assert.equal(calls, 1); assert.equal((await foods()).length, 0);
  const message = draft.messages.find(message => message.role === "user")!;
  assert.equal(message.payload.photoCount, 3); assert.equal(message.payload.photoMode, "meal");
  assert.equal((await getFoodChat(users[0].id, options)).messages[0].payload.photoCount, 3);
  assert.equal(draft.quota.remainingToday, 99);
  await sendFoodChat(users[0].id, input, options); assert.equal(calls, 1);
  await assert.rejects(sendFoodChat(users[0].id, { ...input, photos: photos.slice(0, 2) }, options), code("CHAT_REQUEST_REUSED"));
  await assert.rejects(sendFoodChat(users[0].id, { ...input, photoMode: "angles" }, options), code("CHAT_REQUEST_REUSED"));
  const saved = await confirmFoodChat(users[0].id, draft.draft!.draftId, draft.draft, options);
  assert.equal(saved.draft, null); assert.equal((await foods()).length, 1);
  assert.equal(calls, 1);
});

test("same-food photos are evidence for one serving and exact duplicate images are only sent once", async () => {
  await reset(); const settings = config();
  const photo = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#ccaa88" } }).png().toBuffer();
  let calls = 0;
  const options = { settings, fetcher: (async (url, init) => {
    calls++; const body = JSON.parse(init!.body as string), parts = body.contents[0].parts;
    assert.equal(parts.length, 2); // Text plus one normalized image, not three duplicate images.
    assert.ok(parts[0].text.includes('"mode":"angles"'));
    assert.ok(parts[0].text.includes('"attachedCount":3'));
    assert.ok(parts[0].text.includes('"distinctImageCount":1'));
    assert.ok(body.systemInstruction.parts[0].text.includes("count that food ONCE"));
    return mock()(url, init);
  }) as typeof fetch };
  const state = await send(0, "Three angles of the same plate; I ate this plate once", options, { photos: [photo, photo, photo], photoMode: "angles" });
  assert.equal(calls, 1); assert.equal(state.draft!.calories, meal.calories);
  assert.equal(state.messages[0].payload.photoCount, 3);
});

test("invalid photo batches fail before a model call and preserve an existing meal draft", async () => {
  await reset(); const settings = config();
  const previous = await send(0, "Breakfast", { settings, fetcher: mock() });
  const photo = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#ccaa88" } }).png().toBuffer();
  let calls = 0; const options = { settings, fetcher: (async () => { calls++; throw new Error("Must not call Google"); }) as typeof fetch };
  await assert.rejects(send(0, "Food", options, { photos: Array(MAX_CHAT_PHOTOS + 1).fill(photo) }), code("CHAT_PHOTOS"));
  await assert.rejects(send(0, "Food", options, { photos: [Buffer.alloc(1024 * 1024 + 1)] }), code("PHOTO_SIZE"));
  await assert.rejects(send(0, "Food", options, { photos: Array(4).fill(Buffer.alloc(800 * 1024)) }), code("CHAT_PHOTO_SIZE"));
  await assert.rejects(send(0, "Food", options, { photos: [photo, Buffer.from("not an image")] }), code("PHOTO_FORMAT"));
  await assert.rejects(send(0, "Food", options, { photos: [photo, photo], photoMode: "invalid" }), code("CHAT_PHOTO_MODE"));
  const after = await getFoodChat(users[0].id, options);
  assert.equal(after.draft!.draftId, previous.draft!.draftId); assert.equal(after.messages.length, previous.messages.length);
  assert.equal(calls, 0);
});

test("photo clarification retains visible-food context for the next text-only reply", async () => {
  await reset(); const settings = config();
  const photos = await Promise.all(["#bb9966", "#aa8877"].map(background => sharp({ create: { width: 60, height: 60, channels: 3, background } }).png().toBuffer()));
  const clarification = "I can see one bowl of rice and one bowl of dal. Are these two views of the same meal, or additional servings?";
  const first = await send(0, "", { settings, fetcher: mock({ intent: "reply", reply: clarification, draft: null }) }, { photos });
  assert.equal(first.draft, null);
  const next = await send(0, "Same meal, just two views", { settings, fetcher: async (url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.equal(body.contents[0].parts.length, 1); // No photo is uploaded or charged as image input again.
    assert.ok(body.contents[0].parts[0].text.includes(clarification));
    assert.ok(body.systemInstruction.parts[0].text.includes("follow-up retains this visual evidence"));
    return mock({ intent: "draft", reply: "Here is one combined meal draft.", draft: { ...meal, name: "Rice and dal" } })(url, init);
  } });
  assert.equal(next.draft!.name, "Rice and dal"); assert.equal((await foods()).length, 0);
});


test("new chat clears conversation, drafts, and cached chat content while preserving food and paid usage", async () => {
  await reset(); const options = { settings: config(), fetcher: mock() };
  const first = (await send(0, "Breakfast", options)).draft!;
  await confirmFoodChat(users[0].id, first.draftId, first, options);
  const pending = (await send(0, "Another meal", options)).draft!;
  const other = await getFoodChat(users[1].id, options);
  const fresh = await resetFoodChat(users[0].id, options);
  assert.equal(fresh.messages.length, 0); assert.equal(fresh.draft, null); assert.equal(fresh.pending, false);
  assert.equal((await foods()).length, 1);
  assert.equal(Number((await foods())[0].calories), first.calories);
  assert.equal((await foods())[0].analysisId, first.analysisId);
  assert.equal((await getFoodChat(users[1].id, options)).version, other.version);
  const [usage] = await db.execute<DatabaseRow[]>("SELECT \"costMicros\", \"resultJson\" FROM \"foodAiUsage\" WHERE scope = $1", [options.settings.scope]);
  assert.equal(usage.length, 2); assert.ok(usage.every(row => row.resultJson === null && Number(row.costMicros) > 0));
  await assert.rejects(confirmFoodChat(users[0].id, pending.draftId, pending, options), code("CHAT_DRAFT"));
});

test("a reply that completes after a reset cannot repopulate the new conversation", async () => {
  await reset(); const settings = config(); let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  const request = send(0, "Breakfast", { settings, fetcher: async (...args) => { started(); await held; return mock()(...args); } });
  await ready;
  await resetFoodChat(users[0].id, { settings }); release();
  await assert.rejects(request, code("CHAT_CHANGED"));
  const fresh = await getFoodChat(users[0].id, { settings }); assert.equal(fresh.messages.length, 0); assert.equal(fresh.draft, null);
});
