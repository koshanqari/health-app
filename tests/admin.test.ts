import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { verifyPassword } from "better-auth/crypto";
import { db, type DatabaseRow } from "../src/lib/db";
import { AdminError, bootstrapAdmin, changeUserRole, createAdmin } from "../src/lib/admin";

const schema = "admin_test_" + randomUUID().replaceAll("-", "");
const env = { BOOT_ADMIN_USER: "bootstrap@example.com", BOOT_ADMIN_PASS: "Bootstrap-" + randomUUID() };
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

test("bootstrap is optional, concurrent-safe, hashes credentials and never changes an existing administrator", async () => {
  assert.equal(await bootstrapAdmin({}, store), "unconfigured");
  assert.equal((await rows("user")).length, 0);
  const results = await Promise.all([bootstrapAdmin(env, store), bootstrapAdmin(env, store)]);
  assert.deepEqual(results.sort(), ["created", "exists"]);
  const user = (await rows("user"))[0], account = (await rows("account"))[0];
  assert.equal(user.role, "admin"); assert.equal(user.email, env.BOOT_ADMIN_USER);
  assert.equal(account.providerId, "credential"); assert.equal(account.accountId, user.id);
  assert.ok(account.password !== env.BOOT_ADMIN_PASS);
  assert.equal(await verifyPassword({ hash: account.password, password: env.BOOT_ADMIN_PASS }), true);
  assert.equal(await bootstrapAdmin({ BOOT_ADMIN_USER: "another@example.com", BOOT_ADMIN_PASS: "changed" }, store), "exists");
  assert.equal((await rows("user")).length, 1);
  assert.ok((await rows("account"))[0].password === account.password);
});

test("bootstrap refuses partial configuration and never takes over a preexisting member email", async () => {
  await assert.rejects(bootstrapAdmin({ BOOT_ADMIN_USER: env.BOOT_ADMIN_USER }, store), fail(400));
  assert.equal((await rows("user")).length, 0);
  await db.execute(`INSERT INTO "${schema}"."user" (id, name, email, role, "emailVerified", "createdAt", "updatedAt") VALUES ($1, 'Member', $2, 'user', FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [randomUUID(), env.BOOT_ADMIN_USER]);
  await assert.rejects(bootstrapAdmin(env, store), fail(409));
  assert.equal((await rows("user"))[0].role, "user");
  assert.equal((await rows("account")).length, 0);
});

test("only current admins create accounts, conflicts preserve credentials, and the last administrator is protected", async () => {
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
