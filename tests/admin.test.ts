import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { db, type DatabaseRow } from "../src/lib/db";
import { AdminError, bootstrapAdmin, changeUserRole, createAdmin } from "../src/lib/admin";

const schema = "admin_test_" + randomUUID().replaceAll("-", "");
const env = { BOOT_ADMIN_USER: "bootstrap@example.com" };
const memberPassword = "Member-" + randomUUID();
async function seedMember(email = env.BOOT_ADMIN_USER) {
  const id = randomUUID(), password = await hashPassword(memberPassword);
  await db.execute(`INSERT INTO "${schema}"."user" (id, name, email, role, "emailVerified", "createdAt", "updatedAt") VALUES ($1, 'Member', $2, 'user', FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [id, email]);
  await db.execute(`INSERT INTO "${schema}"."account" (id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt") VALUES ($1, $2, $2, 'credential', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [randomUUID(), id, password]);
  return { id, password };
}
const store = { getConnection: async () => {
  const connection = await db.getConnection();
  return { ...connection, beginTransaction: async () => {
    await connection.beginTransaction();
    await connection.execute(`SET LOCAL search_path TO "${schema}", public`);
  } };
} };
const rows = async (table: string) => (await db.execute<DatabaseRow[]>(`SELECT * FROM "${schema}"."${table}"`))[0];
const fail = (status: number) => (error: unknown) => error instanceof AdminError && error.status === status;
before(async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname));
  await db.execute(`CREATE SCHEMA "${schema}"`);
  for (const table of ["user", "account", "session"]) await db.execute(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
});
beforeEach(async () => { await db.execute(`TRUNCATE "${schema}"."session", "${schema}"."account", "${schema}"."user"`); });
after(async () => { await db.execute(`DROP SCHEMA "${schema}" CASCADE`); await db.end(); });

test("bootstrap promotes the existing account once, preserving its identity and password under concurrent retries", async () => {
  assert.equal(await bootstrapAdmin({}, store), "unconfigured");
  assert.equal((await rows("user")).length, 0);
  const original = await seedMember();
  const results = await Promise.all([bootstrapAdmin(env, store), bootstrapAdmin(env, store)]);
  assert.deepEqual(results.sort(), ["exists", "promoted"]);
  const user = (await rows("user"))[0], account = (await rows("account"))[0];
  assert.equal(user.id, original.id); assert.equal(user.role, "admin"); assert.equal(user.name, "Member");
  assert.equal(user.email, env.BOOT_ADMIN_USER);
  assert.ok(account.password === original.password);
  assert.equal(await verifyPassword({ hash: account.password, password: memberPassword }), true);
  assert.equal(await bootstrapAdmin({ BOOT_ADMIN_USER: "BOOTSTRAP@example.com", BOOT_ADMIN_PASS: "ignored-obsolete-value" }, store), "exists");
  assert.equal((await rows("user")).length, 1);
  assert.ok((await rows("account"))[0].password === original.password);
});

test("bootstrap refuses missing or invalid accounts and changes only the configured existing member", async () => {
  await assert.rejects(bootstrapAdmin({ BOOT_ADMIN_USER: "invalid" }, store), fail(400));
  await assert.rejects(bootstrapAdmin(env, store), fail(404));
  assert.equal((await rows("user")).length, 0);
  const other = await seedMember("other@example.com");
  await db.execute(`UPDATE "${schema}"."user" SET role = 'admin' WHERE id = $1`, [other.id]);
  await seedMember();
  assert.equal(await bootstrapAdmin(env, store), "promoted");
  assert.equal((await rows("user")).length, 2);
  assert.equal((await rows("user")).filter(user => user.role === "admin").length, 2);
  assert.ok((await rows("account")).find(account => account.userId === other.id)!.password === other.password);
});

test("only current admins create accounts, conflicts preserve credentials, and the last administrator is protected", async () => {
  await seedMember();
  await bootstrapAdmin(env, store);
  const first = (await rows("user"))[0];
  const next = { name: "Second Admin", email: "second@example.com", password: "Second-" + randomUUID() };
  await assert.rejects(createAdmin("unknown", next, store), fail(403));
  await assert.rejects(changeUserRole(first.id, { id: first.id, role: "user" }, store), fail(409));
  const second = await createAdmin(first.id, next, store);
  await assert.rejects(createAdmin(first.id, { ...next, email: "SECOND@example.com" }, store), fail(409));
  const account = (await rows("account")).find(item => item.userId === second.id)!;
  assert.equal(await verifyPassword({ hash: account.password, password: next.password }), true);
  await assert.rejects(changeUserRole(first.id, { id: second.id, role: ["admin"] }, store), fail(400));
  const results = await Promise.allSettled([
    changeUserRole(first.id, { id: first.id, role: "user" }, store),
    changeUserRole(second.id, { id: second.id, role: "user" }, store),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await rows("user")).filter(user => user.role === "admin").length, 1);
  const demoted = (await rows("user")).find(user => user.role === "user")!;
  await assert.rejects(createAdmin(demoted.id, { ...next, email: "third@example.com" }, store), fail(403));
});
