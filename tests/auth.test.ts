import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseRow } from "../src/lib/db";
import { db } from "../src/lib/db";

const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const run = randomUUID().replaceAll("-", "");
const memberEmail = `test-${run}@example.com`;
const adminEmail = `admin-${run}@example.com`;
const password = `Test-${randomUUID()}!`;
const ipPrefix = `198.18.${Math.floor(Math.random() * 240) + 1}.`;
let memberCookie = "";
let adminCookie = "";

function cookies(response: Response) {
  return response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
}

async function post(path: string, body: object, cookie = "", ip = `${ipPrefix}1`, origin = base) {
  return fetch(`${base}/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie, "X-Forwarded-For": ip },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

before(async () => {
  const host = new URL(process.env.DATABASE_URL!).hostname;
  assert.ok(["localhost", "127.0.0.1"].includes(host), "Run integration tests against local Postgres only.");
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Use a local test server only.");
  const ready = await fetch(`${base}/login`);
  assert.equal(ready.status, 200);
  await promisify(execFile)(process.execPath, ["--env-file=.env.local", "--import", "tsx", "scripts/create-admin.ts"], {
    env: { ...process.env, ADMIN_NAME: "Test Administrator", ADMIN_EMAIL: adminEmail, ADMIN_PASSWORD: password },
  });
});

after(async () => {
  const [users] = await db.execute<DatabaseRow[]>("SELECT id FROM \"user\" WHERE email IN ($1, $2, $3)", [memberEmail, adminEmail, `blocked-${run}@example.com`]);
  for (const user of users) {
    await db.execute("DELETE FROM \"session\" WHERE \"userId\" = $1", [user.id]);
    await db.execute("DELETE FROM \"account\" WHERE \"userId\" = $1", [user.id]);
    await db.execute("DELETE FROM \"user\" WHERE id = $1", [user.id]);
  }
  await db.execute("DELETE FROM \"rateLimit\" WHERE \"key\" LIKE $1", [`${ipPrefix}%`]);
  await db.end();
});

test("anonymous visitors cannot read accounts, users, or protected pages", async () => {
  assert.equal((await fetch(`${base}/api/account`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/users`)).status, 401);
  for (const [path, destination] of [["/app", "/login"], ["/admin", "/admin/login"]]) {
    const response = await fetch(base + path, { redirect: "manual" });
    assert.equal(response.status, 307);
    assert.ok(response.headers.get("location")?.endsWith(destination));
  }
});

test("signup persists a member, hashes the password, and ignores a forged admin role", async () => {
  const response = await post("sign-up/email", { email: memberEmail, password, name: "Test Member", role: "admin" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.role, "user");
  memberCookie = cookies(response);
  assert.ok(memberCookie.includes("session_token="));
  assert.ok(response.headers.getSetCookie().some(value => /httponly/i.test(value) && /samesite=lax/i.test(value)));
  const [rows] = await db.execute<DatabaseRow[]>("SELECT a.password, u.role FROM \"account\" a JOIN \"user\" u ON a.\"userId\" = u.id WHERE u.email = $1", [memberEmail]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "user");
  assert.notEqual(rows[0].password, password);
  assert.ok(rows[0].password.length > 60);
});

test("duplicate signup does not create another user", async () => {
  const response = await post("sign-up/email", { email: memberEmail, password, name: "Duplicate" });
  assert.ok(response.status >= 400 && response.status < 500);
  const [rows] = await db.execute<DatabaseRow[]>("SELECT COUNT(*)::integer AS total FROM \"user\" WHERE email = $1", [memberEmail]);
  assert.equal(rows[0].total, 1);
});

test("members cannot read admin data or promote themselves through the API", async () => {
  const response = await fetch(`${base}/api/admin/users`, { headers: { Cookie: memberCookie } });
  assert.equal(response.status, 403);
  const update = await post("update-user", { role: "admin", name: "Updated Member" }, memberCookie);
  assert.ok([200, 400].includes(update.status));
  const account = await fetch(`${base}/api/account`, { headers: { Cookie: memberCookie } });
  assert.equal(account.status, 200);
  assert.equal((await account.json()).user.role, "user");
  const page = await fetch(`${base}/admin`, { headers: { Cookie: memberCookie }, redirect: "manual" });
  assert.equal(page.status, 307);
  assert.ok(page.headers.get("location")?.includes("/app?notice=admin-only"));
});

test("invalid credentials and forged session cookies are rejected", async () => {
  assert.equal((await post("sign-in/email", { email: memberEmail, password: "Incorrect-password-123" })).status, 401);
  assert.equal((await fetch(`${base}/api/account`, { headers: { Cookie: "better-auth.session_token=made-up-session" } })).status, 401);
});

test("foreign-origin signup is rejected without creating a user", async () => {
  const response = await post("sign-up/email", { email: `blocked-${run}@example.com`, password, name: "Blocked" }, "", `${ipPrefix}2`, "https://untrusted.example");
  assert.equal(response.status, 403);
  const [rows] = await db.execute<DatabaseRow[]>("SELECT COUNT(*)::integer AS total FROM \"user\" WHERE email = $1", [`blocked-${run}@example.com`]);
  assert.equal(rows[0].total, 0);
});

test("separately provisioned admin can sign in and list accounts without exposing credentials", async () => {
  const response = await post("sign-in/email", { email: adminEmail, password }, "", `${ipPrefix}3`);
  assert.equal(response.status, 200);
  adminCookie = cookies(response);
  const usersResponse = await fetch(`${base}/api/admin/users`, { headers: { Cookie: adminCookie } });
  assert.equal(usersResponse.status, 200);
  const body = await usersResponse.json();
  assert.ok(body.users.some((user: { email: string }) => user.email === memberEmail));
  for (const user of body.users) {
    assert.equal("password" in user, false);
    assert.equal("token" in user, false);
  }
});

test("login rate limits are enforced and recorded in Postgres", async () => {
  const statuses: number[] = [];
  for (let index = 0; index < 9; index++) {
    const response = await post("sign-in/email", { email: memberEmail, password: "wrong-password-123" }, "", `${ipPrefix}4`);
    statuses.push(response.status);
  }
  assert.ok(statuses.includes(429));
  const [rows] = await db.execute<DatabaseRow[]>("SELECT COUNT(*)::integer AS total FROM \"rateLimit\" WHERE \"key\" LIKE $1", [`${ipPrefix}%`]);
  assert.ok(rows[0].total > 0);
});

test("logout revokes the session, including reuse of the old cookie", async () => {
  assert.equal((await post("sign-out", {}, memberCookie, `${ipPrefix}5`)).status, 200);
  assert.equal((await fetch(`${base}/api/account`, { headers: { Cookie: memberCookie } })).status, 401);
  assert.equal((await post("sign-out", {}, adminCookie, `${ipPrefix}6`)).status, 200);
});
