import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { activityTypes, activityDetails, activityFacts, parseActivityFacts, parseActivityGoals, prepareActivityChatProposal, resolveActivity } from "../src/lib/activity";
import { confirmFoodChatActivity, getFoodChat, resetFoodChat, sendFoodChat } from "../src/lib/food-chat";
import type { FoodAiSettings } from "../src/lib/food-ai";
const base = process.env.TEST_BASE_URL || "http://localhost:3001";
const users: { id: string; cookie: string }[] = [];
const scope = "activity-test-" + randomUUID();
const settings: FoodAiSettings = { scope, apiKey: "fake-key", globalDailyLimit: 100, monthlyBudgetMicros: 1000000 };
const walk = { type: "walking", durationMinutes: 60, distanceKm: 5, steps: 6000, occurredAtLocal: "2026-11-10T10:00", timeZone: "Asia/Kolkata" };
const request = (method: string, body?: unknown, index = 0, path = "/api/activity") => fetch(base + path, { method, headers: { Cookie: users[index]?.cookie ?? "", Origin: base, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
before(async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname));
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + "/api/auth/sign-up/email", { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-Forwarded-For": `198.36.${Math.floor(Math.random() * 240) + 1}.${i + 1}` }, body: JSON.stringify({ name: "Activity Fixture", email: `activity-${randomUUID()}@example.com`, password: randomUUID() + "!" }) });
    assert.equal(response.status, 200); users.push({ id: (await response.json()).user.id, cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") });
  }
});
after(async () => { await db.execute('DELETE FROM "foodAiUsage" WHERE scope=$1', [scope]); await db.execute('DELETE FROM "foodAiBudget" WHERE scope=$1', [scope]); await db.execute('DELETE FROM "adminView" WHERE "actorId"=$1', [users[0]?.id]); for (const user of users) await db.execute('DELETE FROM "user" WHERE id=$1', [user.id]); await db.end(); });

test("all ten types use independent inputs and net active energy, with explicit override", () => {
  const profile = { weightKg: 70, age: 30 };
  assert.equal(activityTypes.length, 10);
  const walking = resolveActivity(walk, profile);
  assert.equal(walking.met, 3.8); assert.equal(walking.calories, 205.8); assert.equal(walking.referenceCode, "17190");
  for (const type of activityTypes) {
    const resolved = resolveActivity({ ...walk, type, steps: null, distanceKm: ["walking", "running", "cycling"].includes(type) ? type === "running" ? 10 : type === "cycling" ? 20 : 5 : null, detail: activityDetails[type]?.[0].key, ...(type === "others" ? { calorieSource: "manual", calories: 225 } : {}) }, profile);
    assert.ok(resolved.calories !== null && resolved.calories > 0); assert.equal(resolveActivity(activityFacts(resolved), profile).calories, resolved.calories);
  }
  assert.equal(resolveActivity({ type: "others", name: "Dance", calories: 0, calorieSource: "device" }, { weightKg: null, age: 70 }).calories, 0);
  assert.throws(() => resolveActivity({ ...walk, distanceKm: null }, profile), /duration and distance/);
  assert.throws(() => resolveActivity(walk, { age: 30, weightKg: null }), /weight/);
  assert.throws(() => resolveActivity(walk, { age: 16, weightKg: 70 }), /19–59/);
  assert.throws(() => resolveActivity({ ...walk, durationMinutes: 1, distanceKm: 100 }, profile), /speed/);
  assert.equal(resolveActivity(walk, { age: null, weightKg: 70 }).assumptions.includes("age not supplied"), true);
});
test("daily and session step-only logs need no profile or invented energy", () => {
  const day = resolveActivity({ type: "walking", stepScope: "daily_total", calorieSource: "not_estimated", steps: 3000 }, { age: null, weightKg: null });
  assert.equal(day.calories, null); assert.equal(day.durationMinutes, null); assert.equal(day.distanceKm, null); assert.equal(day.name, "Daily steps");
  assert.equal(resolveActivity({ type: "walking", calorieSource: "not_estimated", steps: 2000 }, { age: 70, weightKg: null }).calories, null);
  for (const patch of [{ durationMinutes: 30 }, { calories: 100 }, { calorieSource: "estimated" }, { type: "swimming" }]) assert.throws(() => resolveActivity({ ...activityFacts(day), ...patch }, { age: 30, weightKg: 70 }));
});
test("strict values reject tampered metadata, invalid dates and redundant fields", () => {
  for (const data of [{ ...walk, met: 20 }, { ...walk, pace: 1 }, { ...walk, calories: 5 }, { ...walk, steps: -1 }, { ...walk, steps: 10.5 }, { ...walk, occurredAtLocal: "2026-02-30T10:00" }, { ...walk, occurredAtLocal: "2026-11-10T24:00" }, { ...walk, timeZone: "Invalid" }, { ...walk, type: "badminton" }, { ...walk, durationMinutes: Infinity }, { ...walk, detail: "wrong" }]) assert.throws(() => parseActivityFacts(data));
  assert.deepEqual(parseActivityGoals({ steps: 8000 }), { calories: null, minutes: null, steps: 8000 });
  for (const data of [{ steps: 2.5 }, { minutes: 1441 }, { calories: 0 }, { fat: 10 }]) assert.throws(() => parseActivityGoals(data));
});
test("activity endpoints enforce authentication, origins, JSON and profile requirements", async () => {
  assert.equal((await fetch(base + "/api/activity?date=2026-11-10")).status, 401);
  assert.equal((await request("GET", undefined, 0, "/api/activity?date=2026-02-30")).status, 400);
  assert.equal((await request("GET", undefined, 0, "/api/activity?date=2026-11-10&period=D")).status, 400);
  assert.equal((await fetch(base + "/api/activity", { method: "POST", headers: { Cookie: users[0].cookie, Origin: "https://outside.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await fetch(base + "/api/activity", { method: "POST", headers: { Cookie: users[0].cookie, Origin: base }, body: "{}" })).status, 415);
  assert.equal((await request("POST", { id: randomUUID(), activity: walk })).status, 400);
  assert.equal((await request("PATCH", { weightKg: 70, age: 30 }, 0, "/api/account")).status, 200);
});
test("create retries are idempotent, edits preserve weight snapshots and reject stale revisions", async () => {
  const id = randomUUID();
  const responses = await Promise.all([request("POST", { id, activity: walk }), request("POST", { id, activity: walk })]);
  assert.ok(responses.every(response => response.status === 201));
  const first = await responses[0].json(); assert.equal(first.calories, 205.8); assert.equal(first.weightKg, 70);
  assert.equal((await request("POST", { id, activity: { ...walk, steps: 6100 } })).status, 409);
  assert.equal((await request("PATCH", { weightKg: 100 }, 0, "/api/account")).status, 200);
  const changed = await request("PATCH", { id, revision: 1, activity: { ...walk, notes: "New note" } });
  assert.equal(changed.status, 200); assert.equal((await changed.json()).calories, 205.8);
  assert.equal((await request("PATCH", { id, revision: 1, activity: walk })).status, 409);
  assert.equal((await request("PATCH", { id, revision: 2, activity: walk }, 1)).status, 404);
  assert.equal((await request("DELETE", { id, revision: 1 })).status, 409);
  const journal = await (await request("GET", undefined, 0, "/api/activity?date=2026-11-10")).json();
  assert.equal(journal.entries.length, 1); assert.equal(journal.day.calories, 205.8); assert.equal(journal.day.steps, 6000); assert.equal(journal.day.minutes, 60);
  assert.equal((await (await request("GET", undefined, 1, "/api/activity?date=2026-11-10")).json()).entries.length, 0);
  assert.equal((await request("DELETE", { id, revision: 2 })).status, 200);
});
test("history zero-fills periods and retains dated goals independently of later changes", async () => {
  for (const effectiveFrom of ["2026-10-01", "2026-11-11"]) assert.equal((await request("PUT", { effectiveFrom, goals: { steps: effectiveFrom.includes("10-01") ? 5000 : 8000, calories: 200, minutes: 30 } })).status, 200);
  await request("POST", { id: randomUUID(), activity: walk });
  const response = await request("GET", undefined, 0, "/api/activity?period=M&date=2026-11-10"), history = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(history.days.length, 30); assert.equal(history.days.find((day: any) => day.date === "2026-11-10").entries, 1);
  assert.equal(history.days[0].calories, 0); assert.deepEqual(history.goalVersions.map((version: any) => version.goals.steps), [5000, 8000]);
  assert.equal((await (await request("GET", undefined, 0, "/api/activity?date=2026-11-10")).json()).goals.steps, 5000);
  assert.equal((await (await request("GET", undefined, 0, "/api/activity?date=2026-11-12")).json()).goals.steps, 8000);
  assert.equal((await (await request("GET", undefined, 1, "/api/activity?period=W&date=2026-11-10")).json()).goalVersions.length, 0);
});
test("Kay prepares deterministic estimates, requires review and saves once with reviewed weight", async () => {
  const options = { settings, fetcher: (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string); assert.ok(body.systemInstruction.parts[0].text.includes("server calculates")); assert.ok(body.contents[0].parts[0].text.includes("savedActivity"));
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ intent: "activity", reply: "Review this walk before saving.", draft: null, goalDraft: null, profileDraft: null, activityDraft: { activity: { ...walk, name: "Morning walk", calories: null, calorieSource: "estimated" } } }) }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 } });
  }) as typeof fetch };
  const before = await getFoodChat(users[0].id, options), state = await sendFoodChat(users[0].id, { requestId: randomUUID(), version: before.version, text: "I walked 5 km in an hour", timeZone: "Asia/Kolkata" }, options);
  assert.equal(state.draft, null); assert.ok(state.activityDraft); const draft = state.activityDraft!;
  assert.equal(draft.activity.weightKg, 100); assert.equal(draft.activity.calories, 294);
  const [beforeRows] = await db.execute('SELECT id FROM "activityEntry" WHERE id=$1', [draft.draftId]); assert.equal(beforeRows.length, 0);
  await request("PATCH", { weightKg: 80 }, 0, "/api/account");
  await assert.rejects(confirmFoodChatActivity(users[1].id, draft.draftId, activityFacts(draft.activity), options));
  await Promise.all([confirmFoodChatActivity(users[0].id, draft.draftId, activityFacts(draft.activity), options), confirmFoodChatActivity(users[0].id, draft.draftId, activityFacts(draft.activity), options)]);
  const [rows] = await db.execute('SELECT data FROM "activityEntry" WHERE id=$1', [draft.draftId]); assert.equal(rows.length, 1); assert.equal(rows[0].data.weightKg, 100); assert.equal(rows[0].data.calories, 294);
  await resetFoodChat(users[0].id, options); const [retained] = await db.execute('SELECT "chatMessageId" FROM "activityEntry" WHERE id=$1', [draft.draftId]); assert.equal(retained.length, 1); assert.equal(retained[0].chatMessageId, null);
});
test("admin views can read activity but cannot create, edit, delete, set goals or confirm drafts", async () => {
  await db.execute('UPDATE "user" SET role=\'admin\' WHERE id=$1', [users[0].id]);
  const response = await request("POST", { userId: users[1].id }, 0, "/api/admin/views"); assert.equal(response.status, 200);
  const token = new URL((await response.json()).url, base).searchParams.get("view")!;
  for (const method of ["POST", "PATCH", "DELETE", "PUT"]) assert.equal((await request(method, {}, 0, "/api/activity?view=" + token)).status, 403);
  assert.equal((await request("PATCH", { activity: {} }, 0, "/api/food/chat?view=" + token)).status, 403);
  const journal = await request("GET", undefined, 0, "/api/activity?date=2026-11-10&view=" + token); assert.equal(journal.status, 200); assert.equal((await journal.json()).entries.length, 0);
});

test("daily step total includes session steps and Kay updates the total instead of adding another", async () => {
  await request("PATCH", { heightCm: 175 }, 0, "/api/account");
  // End the admin view created above; this is the actual account's own journal.
  const id = randomUUID(), daily = { type: "walking", stepScope: "daily_total", calorieSource: "not_estimated", steps: 3000, occurredAtLocal: "2026-11-09T23:00", timeZone: "Asia/Kolkata" };
  assert.equal((await request("POST", { id, activity: daily })).status, 201);
  const walkId = randomUUID();
  assert.equal((await request("POST", { id: walkId, activity: { ...walk, steps: 2000, occurredAtLocal: "2026-11-09T10:00" } })).status, 201);
  const journal = await (await request("GET", undefined, 0, "/api/activity?date=2026-11-09")).json();
  assert.equal(journal.day.steps, 3000); assert.equal(journal.day.calories, 235.2); assert.equal(journal.entries.find((entry: any) => entry.id === id).calories, null);
  assert.equal((await request("POST", { id: randomUUID(), activity: daily })).status, 409);
  const options = { settings, fetcher: (async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ intent: "activity", reply: "Review your daily total.", draft: null, goalDraft: null, profileDraft: null, activityDraft: { activity: { ...daily, steps: 3500 } } }) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } })) as typeof fetch };
  const before = await getFoodChat(users[0].id, options);
  const state = await sendFoodChat(users[0].id, { requestId: randomUUID(), version: before.version, text: "3500 steps total throughout that day", timeZone: "Asia/Kolkata" }, options);
  const draft = state.activityDraft!; assert.equal(draft.targetEntryId, id);
  await confirmFoodChatActivity(users[0].id, draft.draftId, activityFacts(draft.activity), options);
  const saved = await (await request("GET", undefined, 0, "/api/activity?date=2026-11-09")).json();
  assert.equal(saved.entries.length, 2); assert.equal(saved.day.steps, 3500);
  const history = await (await request("GET", undefined, 0, "/api/activity?date=2026-11-09&period=M")).json(); assert.equal(history.days.find((day: any) => day.date === "2026-11-09").steps, 3500);
});

test("activity chat asks for missing effort or weight and discards model-computed calories", () => {
  const facts = { type: "badminton", durationMinutes: 30, calorieSource: "estimated", occurredAtLocal: "2026-11-19T10:00" };
  const profile = { age: 30, weightKg: 70 };
  for (const detail of [null, "moderate", "recreational"]) {
    const reply = prepareActivityChatProposal({ ...facts, detail }, profile, "Asia/Kolkata");
    assert.match(reply.question!, /social\/casual or competitive/); assert.match(reply.question!, /30-minute/); assert.equal(reply.activity, undefined);
  }
  const missingWeight = prepareActivityChatProposal({ ...facts, detail: "social" }, { age: 30, weightKg: null }, "Asia/Kolkata"); assert.match(missingWeight.question!, /weight in kg/);
  const estimate = prepareActivityChatProposal({ ...facts, detail: "social", calories: 9999 }, profile, "Asia/Kolkata");
  assert.equal(estimate.activity?.calories, 165.38); assert.equal(estimate.activity?.durationMinutes, 30);
  assert.equal(prepareActivityChatProposal({ ...facts, calories: 120, calorieSource: "device" }, { age: null, weightKg: null }, "Asia/Kolkata").activity?.calories, 120);
  assert.ok(prepareActivityChatProposal({ ...facts, durationMinutes: "30" }, profile, "Asia/Kolkata").question);
});
test("badminton clarification is a successful reply, retains context and only saves after review", async () => {
  await request("PATCH", { age: 30, weightKg: 80 }, 0, "/api/account");
  const count = async () => { const [rows] = await db.execute('SELECT COUNT(*)::int AS count FROM "activityEntry" WHERE "userId"=$1', [users[0].id]); return rows[0].count; };
  const originalCount = await count();
  let calls = 0;
  const options = { settings, fetcher: (async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.ok(body.generationConfig.responseJsonSchema.properties.activityDraft.properties.activity.properties.detail.enum.includes("social"));
    if (calls === 2) assert.ok(body.contents[0].parts[0].text.includes("30-minute duration"));
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ intent: "activity", reply: "I've logged your badminton.", draft: null, goalDraft: null, profileDraft: null, activityDraft: { activity: { type: "badminton", durationMinutes: 30, detail: calls === 1 ? "moderate" : "social", calorieSource: "estimated", calories: 300, occurredAtLocal: "2026-11-19T10:00" } } }) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } });
  }) as typeof fetch };
  const previous = await getFoodChat(users[0].id, options);
  const clarified = await sendFoodChat(users[0].id, { requestId: randomUUID(), version: previous.version, text: "i played badminton for 30 min", timeZone: "Asia/Kolkata" }, options);
  assert.equal(clarified.pending, false); assert.equal(clarified.activityDraft, null);
  assert.match(clarified.messages.at(-1)!.content, /social\/casual or competitive/); assert.equal(clarified.messages.at(-1)!.payload.state, "ready"); assert.equal(await count(), originalCount);
  const prepared = await sendFoodChat(users[0].id, { requestId: randomUUID(), version: clarified.version, text: "casual", timeZone: "Asia/Kolkata" }, options);
  assert.equal(prepared.activityDraft!.activity.calories, 189); assert.match(prepared.messages.at(-1)!.content, /ready to review/); assert.doesNotMatch(prepared.messages.at(-1)!.content, /I've logged/); assert.equal(await count(), originalCount);
  await confirmFoodChatActivity(users[0].id, prepared.activityDraft!.draftId, activityFacts(prepared.activityDraft!.activity), options);
  assert.equal(await count(), originalCount + 1);
});

test("daily walking estimates active calories from steps and saved height without any duration", () => {
  const facts = { type: "walking", stepScope: "daily_total", calorieSource: "estimated", steps: 10000, occurredAtLocal: "2026-11-19T23:00" };
  const profile = { age: 30, weightKg: 101, heightCm: 175 };
  const result = resolveActivity(facts, profile);
  assert.equal(resolveActivity({ ...facts, steps: 12000 }, { age: 30, weightKg: 70, heightCm: 175 }).calories, 305.03);
  assert.equal(result.calories, 366.76); assert.equal(result.durationMinutes, null); assert.equal(result.distanceKm, null);
  assert.ok(Math.abs(result.stepEstimate!.distanceKm - 7.2625) < 1e-9); assert.equal(result.stepEstimate?.distanceSource, "height");
  assert.match(result.assumptions, /41.5%/); assert.match(result.assumptions, /No duration assumed/);
  const edited = resolveActivity({ ...facts, steps: 12000 }, { age: 35, weightKg: 70, heightCm: 160 }, result);
  assert.equal(edited.weightKg, 101); assert.equal(edited.stepEstimate?.heightCm, 175); assert.equal(edited.calories, 440.11);
  assert.equal(resolveActivity({ ...facts, distanceKm: 6 }, { age: 30, weightKg: 101, heightCm: null }).calories, 303);
  assert.equal(resolveActivity({ ...facts, steps: 0 }, { age: null, weightKg: 70, heightCm: null }).calories, 0);
  assert.throws(() => resolveActivity({ ...facts, steps: 0, distanceKm: 6 }, profile), /Clear distance/);
  const clarification = prepareActivityChatProposal(facts, { age: 30, weightKg: null, heightCm: null }, "Asia/Kolkata");
  assert.match(clarification.question!, /weight/); assert.match(clarification.question!, /height/); assert.doesNotMatch(clarification.question!, /duration|pace/);
  const legacyModel = prepareActivityChatProposal({ ...facts, calorieSource: "not_estimated" }, profile, "Asia/Kolkata"); assert.equal(legacyModel.activity?.calories, 366.76);
  assert.equal(prepareActivityChatProposal({ ...facts, calorieSource: "device", calories: 400 }, { age: null, weightKg: null }, "Asia/Kolkata").activity?.calories, 400);
});
test("daily calories persist with snapshots and history counts overlapping step sessions once", async () => {
  await request("PATCH", { age: 30, weightKg: 101, heightCm: 175 }, 0, "/api/account");
  const id = randomUUID(), date = "2026-11-08", facts = { type: "walking", stepScope: "daily_total", calorieSource: "estimated", steps: 10000, occurredAtLocal: date + "T23:00" };
  const created = await request("POST", { id, activity: facts }); assert.equal(created.status, 201); assert.equal((await created.json()).calories, 366.76);
  const walkId = randomUUID(); await request("POST", { id: walkId, activity: { ...walk, occurredAtLocal: date + "T10:00" } });
  const sportId = randomUUID(); await request("POST", { id: sportId, activity: { type: "badminton", durationMinutes: 30, detail: "social", occurredAtLocal: date + "T18:00" } });
  const diary = async () => (await (await request("GET", undefined, 0, "/api/activity?date=" + date)).json());
  let journal = await diary(); assert.equal(journal.day.steps, 10000); assert.equal(journal.day.calories, 605.37); assert.equal(journal.day.minutes, 90);
  await request("PATCH", { weightKg: 80, heightCm: 160 }, 0, "/api/account");
  const edited = await request("PATCH", { id, revision: 1, activity: { ...facts, steps: 12000 } }); assert.equal(edited.status, 200);
  const saved = await edited.json(); assert.equal(saved.calories, 440.11); assert.equal(saved.stepEstimate.heightCm, 175); assert.equal(saved.weightKg, 101);
  const history = await (await request("GET", undefined, 0, "/api/activity?date=" + date + "&period=M")).json(); assert.equal(history.days.find((day: any) => day.date === date).calories, 678.72);
  assert.equal((await request("DELETE", { id, revision: 2 })).status, 200); journal = await diary(); assert.equal(journal.day.calories, 535.55);
});
