import { localDateTime } from "../src/lib/food";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseRow } from "../src/lib/db";
import { db } from "../src/lib/db";
import sharp from "sharp";
import { getCreditDefaults, saveCreditDefaults } from "../src/lib/credits";
import { sendFoodChat } from "../src/lib/food-chat";
import type { FoodAiSettings } from "../src/lib/food-ai";
import { suggestedFoodGoals, suggestedMacros } from "../src/lib/food-goals";

const baseURL = process.env.TEST_BASE_URL || "http://localhost:3000";
const run = randomUUID().replaceAll("-", "");
const memberEmail = `browser-${run}@example.com`;
const signupEmail = `browser-signup-${run}@example.com`;
const adminEmail = `browser-admin-${run}@example.com`;
const password = `Browser-${randomUUID()}!`;
const aiScope = `browser-ai-${run}`;
const aiQuota = { configured: true, remainingToday: 9, monthlyBudgetUsd: 1, remainingBudgetUsd: .99 };
let memberId: string;
const chatSettings: FoodAiSettings = { apiKey: "browser-fake-key", scope: aiScope, globalDailyLimit: 100, monthlyBudgetMicros: 1000000 };

const browserIssues = new WeakMap<Page, string[]>();

test.beforeEach(async ({ context, page }) => {
  const issues: string[] = [];
  browserIssues.set(page, issues);
  page.on("pageerror", error => issues.push(error.message));
  page.on("console", message => {
    if (message.type() === "warning" || (message.type() === "error" && !message.text().startsWith("Failed to load resource:"))) {
      issues.push(message.text());
    }
  });
  // Isolate each local browser scenario's rate-limit budget.
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `198.19.${Math.floor(Math.random() * 240) + 1}.${Math.floor(Math.random() * 240) + 1}` });
  // Never send paid chat requests from browser tests. Reads and confirms still use the real server.
  await page.route("**/api/food/chat*", async route => {
    if (route.request().method() === "POST") return route.fulfill({ status: 503, json: { message: "Mock provider not configured for this browser test." } });
    const response = await route.fetch(), body = await response.json();
    if (response.ok()) body.quota = { ...body.quota, ...aiQuota };
    await route.fulfill({ response, json: body });
  });
});

test.afterEach(async ({ page }) => {
  expect(browserIssues.get(page)).toEqual([]);
});

test.beforeAll(async ({ request }) => {
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) {
    throw new Error("Browser fixtures require local Postgres.");
  }
  await promisify(execFile)(process.execPath, ["--env-file=.env.local", "--import", "tsx", "scripts/create-admin.ts"], {
    env: { ...process.env, ADMIN_NAME: "Browser Administrator", ADMIN_EMAIL: adminEmail, ADMIN_PASSWORD: password },
  });
  const member = await request.post("/api/auth/sign-up/email", {
    headers: { Origin: baseURL, "x-forwarded-for": `198.17.${Math.floor(Math.random() * 240) + 1}.1` },
    data: { name: "Test Member", email: memberEmail, password },
  });
  expect(member.status()).toBe(200);
  memberId = (await member.json()).user.id;
  const month = new Date().toISOString().slice(0, 7);
  await db.execute("INSERT INTO \"foodAiBudget\" (scope, month, \"usedMicros\") VALUES ($1, $2, 0)", [aiScope, month]);
});

test.afterAll(async () => {
  await db.execute("DELETE FROM \"foodAiUsage\" WHERE scope = $1", [aiScope]);
  await db.execute("DELETE FROM \"foodAiBudget\" WHERE scope = $1", [aiScope]);
  const [users] = await db.execute<DatabaseRow[]>("SELECT id FROM \"user\" WHERE email IN ($1, $2, $3)", [memberEmail, adminEmail, signupEmail]);
  await db.execute('DELETE FROM "adminView" WHERE "actorId" = ANY($1::text[]) OR "targetId" = ANY($1::text[])', [users.map(user => user.id)]);
  for (const user of users) {
    await db.execute("DELETE FROM \"session\" WHERE \"userId\" = $1", [user.id]);
    await db.execute("DELETE FROM \"account\" WHERE \"userId\" = $1", [user.id]);
    await db.execute("DELETE FROM \"user\" WHERE id = $1", [user.id]);
  }
  await db.end();
});

test("login, signup, and admin login render without overflow or browser errors", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const path of ["/login", "/signup", "/admin"]) {
    await page.goto(path);
    await expect(page.getByLabel("Email address", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-${path.replaceAll("/", "-")}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});

test("signup validates confirmation, creates a user, persists login, and signs out", async ({ page }, info) => {
  await page.goto("/signup");
  await page.getByLabel("Your name", { exact: true }).fill("Jamie Morgan");
  await page.getByLabel("Email address", { exact: true }).fill(signupEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill("different-password-123");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("form", { name: "Create your account" }).getByRole("alert")).toContainText("don’t match");
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Hi, Jamie.", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Profile setup", exact: true })).toBeVisible();
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-member.png`, fullPage: true });
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  for (const tab of [
    { name: "Food", heading: "Food" },
    { name: "Activity", heading: "Activity" },
    { name: "Progress", heading: "Your progress" },
  ]) {
    await navigation.getByRole("link", { name: tab.name, exact: true }).click();
    if (tab.name === "AI") await expect(page.getByRole("region", { name: "Kay", exact: true })).toBeVisible();
      else await expect(page.getByRole("heading", { name: tab.heading, exact: true })).toBeVisible();
    await expect(navigation.getByRole("link", { name: tab.name, exact: true })).toHaveAttribute("aria-current", "page");
    if (tab.name === "Food") await expect(page.getByRole("button", { name: "Log food", exact: true })).toBeVisible();
    else if (tab.name === "Progress") await expect(page.locator(".tab-placeholder:visible").getByText("Coming soon", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.reload();
  await expect(navigation.getByRole("link", { name: "Progress", exact: true })).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hi, Jamie.", exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const accountBox = await page.locator(".home-today-food").boundingBox();
  const navigationBox = await navigation.boundingBox();
  expect(accountBox!.y + accountBox!.height).toBeLessThanOrEqual(navigationBox!.y);

  await expect(page.locator(".app-header").getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open profile", exact: true }).click();
  await page.getByRole("dialog", { name: "Profile", exact: true }).getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
});

test("member login works and an ordinary member cannot use admin login", async ({ page }) => {
  await page.goto("/admin");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("form", { name: "Administrator sign in" }).getByRole("alert")).toContainText("doesn’t have administrator access");
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/app\?notice=admin-only$/);
});

test("administrator sees real accounts and can search and filter the directory", async ({ page }, info) => {
  await page.goto("/admin");
  await page.getByLabel("Email address", { exact: true }).fill(adminEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Your community" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search accounts" }).fill(memberEmail);
  await expect(page.getByRole("cell", { name: memberEmail, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Administrators", exact: true }).click();
  await expect(page.getByText("No accounts match this search.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-admin.png`, fullPage: true });
  await page.getByRole("button", { name: "Open profile", exact: true }).click();
  await page.getByRole("dialog", { name: "Profile", exact: true }).getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
});

test("food journal saves, edits, summarizes, and deletes food with Healthy as the default", async ({ page }, info) => {
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Food", exact: true }).click();
  await expect(page.getByRole("button", { name: "Use photo", exact: true })).toHaveCount(0);
  const day = "2033-07-12";
  await page.getByLabel("Journal date", { exact: true }).fill(day);
  await expect(page.getByRole("heading", { name: "A little space for what you ate." })).toBeVisible();
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: "Healthy", exact: true })).toBeChecked();
  await dialog.getByLabel("Food name", { exact: true }).fill("Paneer sandwich");
  for (const [label, value] of [["Calories (kcal)", "400"], ["Protein (g)", "20"], ["Carbs (g)", "50"], ["Fat (g)", "10"]]) await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog.getByLabel("Meal", { exact: true }).selectOption("lunch");
  await dialog.getByLabel("Date and time", { exact: true }).fill(day + "T12:30");
  const categoryBox = await dialog.getByRole("radio", { name: "Unhealthy", exact: true }).boundingBox();
  const actionsBox = await dialog.getByRole("button", { name: "Save food", exact: true }).boundingBox();
  expect(categoryBox!.y + categoryBox!.height).toBeLessThanOrEqual(actionsBox!.y);
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-food-form.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Save food", exact: true }).click();
  const entry = page.getByRole("article", { name: "Paneer sandwich", exact: true });
  await expect(entry).toBeVisible();
  await expect(entry.getByText("Healthy", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByLabel("Journal date", { exact: true }).fill(day);
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "Healthy", exact: true })).toBeChecked();
  await dialog.getByRole("radio", { name: "Unhealthy", exact: true }).check();
  await dialog.getByLabel("Calories (kcal)", { exact: true }).fill("450");
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(entry.getByText("Unhealthy", { exact: true })).toBeVisible();
  await expect(entry).toContainText("450");
  await expect(page.getByRole("region", { name: "Daily nutrition summary" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Summary period" })).toHaveCount(0);
  await entry.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "Unhealthy", exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "Healthy", exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-food.png`, fullPage: true });
  await entry.getByRole("button", { name: "Delete", exact: true }).click();
  await entry.getByRole("button", { name: "Keep entry", exact: true }).click();
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: "Delete", exact: true }).click();
  await entry.getByRole("button", { name: "Delete entry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A little space for what you ate." })).toBeVisible();
  await expect(page.getByRole("region", { name: /Meals for/ })).toContainText("0 entries logged");
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Save food", exact: true })).toBeDisabled();
  await dialog.getByLabel("Calories (kcal)", { exact: true }).fill("225");
  await dialog.getByLabel("Fat (g)", { exact: true }).fill("5");
  await dialog.getByLabel("Protein (g)", { exact: true }).fill("10");
  await expect(dialog.getByRole("button", { name: "Save food", exact: true })).toBeDisabled();
  await dialog.getByLabel("Carbs (g)", { exact: true }).fill("30");
  await expect(dialog.getByLabel("Food name", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Meal", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Save food", exact: true })).toBeEnabled();
  const saveBox = await dialog.getByRole("button", { name: "Save food", exact: true }).boundingBox();
  expect(saveBox!.y).toBeGreaterThanOrEqual(0);
  expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await dialog.getByRole("button", { name: "Save food", exact: true }).click();
  const quickEntry = page.getByRole("article", { name: "Food entry", exact: true });
  await expect(quickEntry).toBeVisible();
  await expect(page.getByRole("region", { name: "Other", exact: true })).toContainText("225");
  await page.reload();
  await page.getByLabel("Journal date", { exact: true }).fill(day);
  await expect(quickEntry).toBeVisible();
  await quickEntry.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(dialog.getByLabel("Food name", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Meal", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("radio", { name: "Healthy", exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await quickEntry.getByRole("button", { name: "Delete", exact: true }).click();
  await quickEntry.getByRole("button", { name: "Delete entry", exact: true }).click();
  await expect(quickEntry).toHaveCount(0);
});

test("daily goals suggest editable macros, persist, and update remaining amounts after logging", async ({ page }, info) => {
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Food", exact: true }).click();
  await page.getByLabel("Journal date", { exact: true }).fill("2034-08-12");
  const panel = page.getByRole("region", { name: "Daily food goals" });
  await panel.getByRole("button", { name: "Set goals", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Daily food goals" });
  await expect(dialog.getByLabel("Minimum protein (g)", { exact: true })).toHaveValue("137.5");
  await dialog.getByLabel("Minimum calories (kcal)", { exact: true }).fill("2000");
  await expect(dialog.getByLabel("Minimum protein (g)", { exact: true })).toHaveValue("125");
  await dialog.getByLabel("Minimum protein (g)", { exact: true }).fill("140");
  await dialog.getByLabel("Minimum calories (kcal)", { exact: true }).fill("2200");
  await expect(dialog.getByLabel("Minimum protein (g)", { exact: true })).toHaveValue("140");
  await expect(dialog.getByLabel("Minimum carbs (g)", { exact: true })).toHaveValue("275");
  await dialog.getByLabel("Maximum calories (kcal)", { exact: true }).fill("2100");
  await expect(dialog.getByRole("button", { name: "Save goals", exact: true })).toBeDisabled();
  await dialog.getByLabel("Maximum calories (kcal)", { exact: true }).fill("2500");
  await dialog.getByRole("button", { name: "Save goals", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(panel.getByRole("progressbar", { name: "Calories goal", exact: true })).toHaveAttribute("aria-valuenow", "0");
  await page.reload();
  await panel.getByRole("button", { name: "Edit goals", exact: true }).click();
  await expect(dialog.getByLabel("Minimum protein (g)", { exact: true })).toHaveValue("140");
  await dialog.getByLabel("Minimum calories (kcal)", { exact: true }).fill("2000");
  await expect(dialog.getByLabel("Minimum protein (g)", { exact: true })).toHaveValue("140");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  const foodDialog = page.getByRole("dialog", { name: "Log food", exact: true });
  for (const [label, value] of [["Calories (kcal)", "400"], ["Protein (g)", "20"], ["Carbs (g)", "50"], ["Fat (g)", "10"]]) await foodDialog.getByLabel(label, { exact: true }).fill(value);
  await foodDialog.getByLabel("Food name", { exact: true }).fill("Goals test lunch");
  await foodDialog.getByRole("button", { name: "Save food", exact: true }).click();
  await expect(panel.getByRole("progressbar", { name: "Calories goal", exact: true })).toHaveAttribute("aria-valuenow", "400");
  await expect(panel.locator(".goal-calories .goal-remaining strong")).toHaveText("1,800");
  await expect(panel.locator(".goal-protein .goal-remaining strong")).toHaveText("120");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await panel.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
  const goalBox = await panel.boundingBox(), navigationBox = await page.getByRole("navigation", { name: "Main navigation" }).boundingBox();
  if (info.project.name === "mobile") expect(goalBox!.y + goalBox!.height).toBeLessThanOrEqual(navigationBox!.y);
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-food-goals.png`, fullPage: true });
  await page.getByRole("article", { name: "Goals test lunch", exact: true }).getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete entry", exact: true }).click();
  await expect(panel.getByRole("progressbar", { name: "Calories goal", exact: true })).toHaveAttribute("aria-valuenow", "0");
});

test("food history selects daily totals, colors achieved goals, swipes, and switches all four periods", async ({ page, context }, info) => {
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Food", exact: true }).click();
  const created: string[] = [];
  try {
    const goal = await page.request.put("/api/food/goals", { headers: { Origin: baseURL }, data: { ...suggestedFoodGoals(), effectiveFrom: "2020-01-01" } });
    expect(goal.status()).toBe(200);
    for (const [date, calories] of [["2020-01-20", 2300], ["2020-01-21", 1800], ["2020-01-22", 2600], ["2020-01-23", 2400]] as const) {
      const response = await page.request.post("/api/food", { headers: { Origin: baseURL }, data: { name: "History test meal", calories, ...suggestedMacros(calories), eatenAtLocal: date + "T12:00", timeZone: "Asia/Kolkata" } });
      expect(response.status()).toBe(201); created.push((await response.json()).id);
    }
    await page.getByLabel("Journal date", { exact: true }).fill("2020-01-22");
    const history = page.getByRole("region", { name: "Food goal history" });
    await expect(history.locator('.history-bar[data-date="2020-01-20"]')).toHaveAttribute("data-status", "achieved");
    await expect(history.locator('.history-bar[data-date="2020-01-21"]')).toHaveAttribute("data-status", "outside");
    await expect(history.locator('.history-bar[data-date="2020-01-22"]')).toHaveAttribute("data-status", "outside");
    await expect(history.locator('.history-bar[data-date="2020-01-24"]')).toHaveAttribute("data-status", "unlogged");
    await expect(history.locator(".history-achievement")).toContainText("2 days");
    const canvas = history.getByRole("group", { name: "Daily nutrition chart. Use arrow keys to select a day." });
    await canvas.scrollIntoViewIfNeeded();
    let box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: box.width / 14, y: 120 } });
    await expect(history.locator(".history-value strong")).toHaveText("2,300");
    await expect(history.locator(".history-detail")).toContainText("20 Jan 2020");
    await expect(page.getByLabel("Journal date", { exact: true })).toHaveValue("2020-01-20");
    await canvas.focus(); await canvas.press("ArrowRight");
    await expect(history.locator(".history-value strong")).toHaveText("1,800");
    await expect(history.locator(".history-detail")).toContainText("Outside goal range");
    await history.getByRole("group", { name: "History nutrient" }).getByRole("button", { name: "Protein", exact: true }).click();
    await expect(history.locator(".history-value strong")).toHaveText("112.5");
    await canvas.scrollIntoViewIfNeeded(); box = (await canvas.boundingBox())!;
    if (info.project.name === "mobile") {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width * .2, y: box.y + 120 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + box.width * .8, y: box.y + 120 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    } else {
      await page.mouse.move(box.x + box.width * .2, box.y + 120); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .8, box.y + 120, { steps: 5 }); await page.mouse.up();
    }
    await expect(history.locator('.history-bar[data-date="2020-01-13"]')).toHaveCount(1);
    await history.getByRole("button", { name: "Next period", exact: true }).click();
    await expect(history.locator('.history-bar[data-date="2020-01-20"]')).toHaveCount(1);
    for (const [period, count] of [["M", 31], ["6M", 184], ["Y", 366]] as const) {
      await history.getByRole("group", { name: "History period" }).getByRole("button", { name: period, exact: true }).click();
      await expect(history.locator(".history-bar")).toHaveCount(count);
    }
    await history.getByRole("group", { name: "History period" }).getByRole("button", { name: "W", exact: true }).click();
    await expect(history.locator(".history-bar")).toHaveCount(7);
    await history.getByRole("group", { name: "History nutrient" }).getByRole("button", { name: "Calories", exact: true }).click();
    const picker = history.getByLabel("Choose history date", { exact: true });
    await picker.click();
    await page.keyboard.press("Escape");
    for (const [period, date, first, last] of [
      ["W", "2020-02-06", "2020-02-03", "2020-02-09"],
      ["M", "2020-03-15", "2020-03-01", "2020-03-31"],
      ["6M", "2020-05-19", "2019-12-01", "2020-05-31"],
      ["Y", "2021-06-09", "2021-01-01", "2021-12-31"],
    ]) {
      await history.getByRole("group", { name: "History period" }).getByRole("button", { name: period, exact: true }).click();
      await picker.fill(date);
      await expect(history.locator(".history-bar").first()).toHaveAttribute("data-date", first);
      await expect(history.locator(".history-bar").last()).toHaveAttribute("data-date", last);
      await expect(history.getByRole("group", { name: "History period" }).getByRole("button", { name: period, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByLabel("Journal date", { exact: true })).toHaveValue(date);
    }
    await history.getByRole("group", { name: "History period" }).getByRole("button", { name: "W", exact: true }).click();
    await picker.fill("2020-01-20");
    await expect(history.locator('.history-bar[data-date="2020-01-20"]')).toHaveCount(1);
    await expect(history.getByRole("button", { name: "D", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await history.scrollIntoViewIfNeeded();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await history.screenshot({ path: `/private/tmp/daywell-${info.project.name}-food-history.png` });
    const deleted = await page.request.delete("/api/food", { headers: { Origin: baseURL }, data: { id: created[0] } });
    expect(deleted.status()).toBe(200); created.shift();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("food-chat-saved", { detail: "2020-01-20" })));
    await expect(history.locator('.history-bar[data-date="2020-01-20"]')).toHaveAttribute("data-status", "unlogged");
    await expect(history.locator(".history-achievement")).toContainText("1 day");
  } finally {
    for (const id of created) await page.request.delete("/api/food", { headers: { Origin: baseURL }, data: { id } });
  }
});

test("dated food goals preserve past targets and color history using the goal for each day", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Food", exact: true }).click();
  const created: string[] = [];
  try {
    const baseline = await page.request.put("/api/food/goals", { headers: { Origin: baseURL }, data: { ...suggestedFoodGoals(), effectiveFrom: "2020-01-01" } });
    expect(baseline.status()).toBe(200);
    for (const [date, calories] of [["2019-12-31", 2300], ["2021-03-20", 2300], ["2021-10-20", 2800]] as const) {
      const result = await page.request.post("/api/food", { headers: { Origin: baseURL }, data: { calories, ...suggestedMacros(calories), eatenAtLocal: date + "T12:00", timeZone: "Asia/Kolkata" } });
      expect(result.status()).toBe(201); created.push((await result.json()).id);
    }
    await page.getByLabel("Journal date", { exact: true }).fill("2021-03-20");
    const panel = page.getByRole("region", { name: "Daily food goals" });
    await panel.getByRole("button", { name: "Edit goals", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Daily food goals" });
    const today = await page.evaluate(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10));
    await expect(dialog.getByLabel("Apply from", { exact: true })).toHaveValue(today);
    await dialog.getByLabel("Apply from", { exact: true }).fill("2021-01-01");
    await dialog.getByRole("button", { name: "Save goals", exact: true }).click();
    await expect(panel.locator(".goal-effective-date")).toHaveText("Applies from 1 Jan 2021");
    await panel.getByRole("button", { name: "Edit goals", exact: true }).click();
    await expect(dialog.getByLabel("Apply from", { exact: true })).toHaveValue(today);
    await dialog.getByLabel("Minimum calories (kcal)", { exact: true }).fill("2700");
    await dialog.getByLabel("Maximum calories (kcal)", { exact: true }).fill("3000");
    await dialog.getByLabel("Apply from", { exact: true }).fill("2021-07-01");
    await dialog.getByRole("button", { name: "Save goals", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(panel.getByRole("progressbar", { name: "Calories goal", exact: true })).toHaveAttribute("aria-valuemax", "2500");
    const history = page.getByRole("region", { name: "Food goal history" });
    await history.getByRole("group", { name: "History period" }).getByRole("button", { name: "Y", exact: true }).click();
    await expect(history.locator('.history-bar[data-date="2021-03-20"]')).toHaveAttribute("data-status", "achieved");
    await expect(history.locator('.history-bar[data-date="2021-10-20"]')).toHaveAttribute("data-status", "achieved");
    await history.getByLabel("Choose history date", { exact: true }).fill("2021-10-20");
    await expect(panel.getByRole("progressbar", { name: "Calories goal", exact: true })).toHaveAttribute("aria-valuemax", "3000");
    await expect(panel.locator(".goal-effective-date")).toHaveText("Applies from 1 Jul 2021");
    const edit = await page.request.patch("/api/food", { headers: { Origin: baseURL }, data: { id: created[2], calories: 2600 } });
    expect(edit.status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("food-chat-saved", { detail: "2021-10-20" })));
    await expect(history.locator('.history-bar[data-date="2021-10-20"]')).toHaveAttribute("data-status", "outside");
    await expect(history.locator('.history-bar[data-date="2021-03-20"]')).toHaveAttribute("data-status", "achieved");
    await history.getByLabel("Choose history date", { exact: true }).fill("2019-12-31");
    await expect(panel).toContainText("No goal set for this date.");
    await expect(history.locator('.history-bar[data-date="2019-12-31"]')).toHaveAttribute("data-status", "no-goal");
    await expect(history.locator(".history-detail")).toContainText("No goal set");
  } finally {
    for (const id of created) await page.request.delete("/api/food", { headers: { Origin: baseURL }, data: { id } });
  }
});

test("tabs switch without network, preserve journal state, and support browser history", async ({ page, context }, info) => {
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation.getByRole("link")).toHaveText(["Home", "Food", "AI", "Activity", "Progress"]);
  await navigation.getByRole("link", { name: "Food", exact: true }).click();
  const selectedDate = "2035-08-01";
  await page.getByLabel("Journal date", { exact: true }).fill(selectedDate);
  await expect(page.getByRole("heading", { name: "A little space for what you ate." })).toBeVisible();
  await navigation.getByRole("link", { name: "AI", exact: true }).click();
  await expect(page.getByLabel("Your message", { exact: true })).toBeEnabled();
  await page.getByLabel("Your message", { exact: true }).fill("A draft I haven’t sent");
  await navigation.getByRole("link", { name: "Food", exact: true }).click();
  const requests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/app" || url.pathname.startsWith("/api/food")) requests.push(url.pathname + url.search);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.evaluate(() => {
    const timings: number[] = [];
    (window as unknown as { tabTimings: number[] }).tabTimings = timings;
    document.addEventListener("click", event => {
      const link = (event.target as Element).closest(".bottom-nav a");
      if (!link) return;
      const start = performance.now();
      requestAnimationFrame(() => timings.push(performance.now() - start));
    }, true);
  });
  await context.setOffline(true);
  try {
    for (const tab of [
      { name: "Home", heading: "Hi, Test." },
      { name: "AI", heading: "Kay" },
      { name: "Food", heading: "Food" },
      { name: "Activity", heading: "Activity" },
      { name: "Progress", heading: "Your progress" },
      { name: "Food", heading: "Food" },
    ]) {
      await navigation.getByRole("link", { name: tab.name, exact: true }).click();
      if (tab.name === "AI") await expect(page.getByRole("region", { name: "Kay", exact: true })).toBeVisible();
      else await expect(page.getByRole("heading", { name: tab.heading, exact: true })).toBeVisible();
      await expect(navigation.getByRole("link", { name: tab.name, exact: true })).toHaveAttribute("aria-current", "page");
    }
    await expect(page.getByLabel("Journal date", { exact: true })).toHaveValue(selectedDate);
    await expect(page.getByRole("region", { name: /Meals for/ })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Your progress", exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("heading", { name: "Food", exact: true })).toBeVisible();
    await expect(page.getByLabel("Journal date", { exact: true })).toHaveValue(selectedDate);
    await navigation.getByRole("link", { name: "Home", exact: true }).click();
    await page.getByRole("link", { name: "View food", exact: true }).click();
    await expect(page.getByLabel("Journal date", { exact: true })).toHaveValue(selectedDate);
    expect(requests).toEqual([]);
    const timings = await page.evaluate(() => (window as unknown as { tabTimings: number[] }).tabTimings);
    expect(timings.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...timings)).toBeLessThan(250);
    await info.attach("tab-performance", { body: JSON.stringify({ cpuSlowdown: 4, clickToNextFrameMs: timings, serverRequests: requests.length }), contentType: "application/json" });
    console.log(info.project.name + " tab frames (4x CPU): " + timings.map(value => value.toFixed(1)).join(", ") + " ms; server requests: " + requests.length);
  } finally {
    await context.setOffline(false);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
  await page.reload();
  await expect(page.getByRole("heading", { name: "Food", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Food", exact: true })).toHaveAttribute("aria-current", "page");
});


async function chatLogin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "AI", exact: true }).click();
  await expect(page.getByLabel("Your message", { exact: true })).toBeEnabled();
}
async function mockedChatInput(route: import("@playwright/test").Route) {
  const form = await new Response(new Uint8Array(route.request().postDataBuffer()!), { headers: { "Content-Type": route.request().headers()["content-type"] } }).formData();
  const photos = [...form.getAll("photos"), ...form.getAll("photo")];
  return { requestId: String(form.get("requestId")), version: Number(form.get("version")), text: String(form.get("text")), timeZone: String(form.get("timeZone")), photoMode: (form.get("photoMode") ?? "auto") as "auto" | "meal" | "angles", photos: await Promise.all((photos as File[]).map(async photo => new Uint8Array(await photo.arrayBuffer()))) };
}

test("food chat understands follow-ups, reviews before saving, persists history, and corrects saved meals", async ({ page }, info) => {
  await db.execute("DELETE FROM \"foodChat\" WHERE \"userId\" = $1", [memberId]);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  await page.route("**/api/food/chat", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const data = await mockedChatInput(route);
    const next = await sendFoodChat(memberId, data, { settings: chatSettings, fetcher: async (_url, init) => {
      calls++;
      const body = JSON.parse(init!.body as string), prompt: string = body.contents[0].parts[0].text;
      const context = JSON.parse(prompt.split("Application context (saved records are authoritative):\n")[1].split("\nLatest user message:\n")[0]);
      let value;
      if (data.text.includes("totals")) value = { intent: "summary", reply: "Here are today’s saved totals.", draft: null };
      else {
        const correction = data.text.includes("Actually"), half = data.text.includes("half");
        value = { intent: "draft", reply: half ? "Updated to half of the meal. Review it before logging." : correction ? "Here is the correction to your logged breakfast." : "Here is an estimate for your breakfast.", draft: {
          name: "Poha and chai", calories: half ? 180 : 360, fat: half ? 6 : 12, protein: half ? 4.5 : 9, carbs: half ? 27 : 54,
          meal: "breakfast", category: "healthy", eatenAtLocal: context.localDateTime, assumptions: half ? "Half a bowl of poha and half the chai." : "One bowl of poha and a cup of chai.", targetEntryId: correction ? context.savedRecords.find((entry: { name: string }) => entry.name === "Poha and chai").id : null,
        } };
      }
      if (calls === 1) { started(); await held; }
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 } });
    } });
    await route.fulfill({ json: next });
  });
  await chatLogin(page);
  await expect(page.getByRole("heading", { name: "Hi, I’m Kay.", exact: true })).toBeInViewport();
  await expect(page.locator(".chat-heading, .chat-disclosure")).toHaveCount(0);
  const composer = await page.locator(".chat-composer").boundingBox();
  const bottomNav = await page.getByRole("navigation", { name: "Main navigation" }).boundingBox();
  expect(bottomNav!.y - composer!.y - composer!.height).toBeLessThanOrEqual(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-chat-empty.png`, fullPage: true });
  await page.getByLabel("Your message", { exact: true }).fill("I had poha and chai for breakfast");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await ready;
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  try {
    await expect(page.getByText("Working on your reply…")).toBeVisible();
    await nav.getByRole("link", { name: "Activity", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  } finally { release(); }
  await nav.getByRole("link", { name: "AI", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review meal", exact: true })).toBeVisible();
  await page.getByLabel("Your message", { exact: true }).fill("I only ate half");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review meal", exact: true })).toHaveCount(1);
  await expect(page.getByRole("log", { name: "Conversation with Kay" })).toContainText("Updated to half");
  const [before] = await db.execute<DatabaseRow[]>("SELECT COUNT(*)::integer AS total FROM \"foodEntry\" WHERE \"userId\" = $1", [memberId]); expect(Number(before[0].total)).toBe(0);
  await page.getByRole("button", { name: "Review meal", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Calories (kcal)", { exact: true })).toHaveValue("180");
  await expect(dialog.getByRole("radio", { name: "Healthy", exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Log meal", exact: true }).click();
  await expect(page.getByText("Saved to your food journal.", { exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "Food", exact: true }).click();
  const entry = page.getByRole("article", { name: "Poha and chai", exact: true });
  await expect(entry).toBeVisible(); await expect(entry.getByText("AI estimate", { exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hi, I’m Kay.", exact: true })).toBeVisible();
  await expect(page.getByRole("log", { name: "Conversation with Kay" })).not.toContainText("I only ate half");
  await page.getByLabel("Your message", { exact: true }).fill("Show today’s totals");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByLabel("Today’s logged nutrition", { exact: true })).toContainText("180 kcal");
  await page.getByLabel("Your message", { exact: true }).fill("Actually I ate the whole breakfast");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review correction", exact: true })).toBeVisible();
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-chat-conversation.png`, fullPage: true });
  const sendBox = await page.getByRole("button", { name: "Send message", exact: true }).boundingBox(), navBox = await nav.boundingBox();
  expect(sendBox!.y + sendBox!.height).toBeLessThan(navBox!.y);
  await page.getByRole("button", { name: "Review correction", exact: true }).click();
  await dialog.getByRole("button", { name: "Save correction", exact: true }).click();
  await expect(page.getByText("Correction saved to your journal.")).toBeVisible();
  const [saved] = await db.execute<DatabaseRow[]>("SELECT calories FROM \"foodEntry\" WHERE \"userId\" = $1", [memberId]);
  expect(saved).toHaveLength(1); expect(Number(saved[0].calories)).toBe(360);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Hi, I’m Kay.", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review correction", exact: true })).toHaveCount(0);
  await nav.getByRole("link", { name: "Food", exact: true }).click();
  await entry.getByRole("button", { name: "Delete", exact: true }).click();
  await entry.getByRole("button", { name: "Delete entry", exact: true }).click();
  await expect(entry).toHaveCount(0);
});

test("food chat keeps multiple photos after failure and retries without duplicating the message", async ({ page }, info) => {
  await db.execute("DELETE FROM \"foodChat\" WHERE \"userId\" = $1", [memberId]);
  const requestIds: string[] = [];
  await page.route("**/api/food/chat", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const data = await mockedChatInput(route); requestIds.push(data.requestId);
    expect(data.photos).toHaveLength(3); expect(data.photoMode).toBe("angles");
    for (const photo of data.photos) expect(photo.byteLength).toBeLessThan(1024 * 1024);
    try {
      const next = await sendFoodChat(memberId, data, { settings: chatSettings, fetcher: async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        expect(body.contents[0].parts).toHaveLength(4);
        if (requestIds.length === 1) return new Response("temporary provider failure", { status: 503 });
        const prompt = body.contents[0].parts[0].text;
        const context = JSON.parse(prompt.split("Application context (saved records are authoritative):\n")[1].split("\nLatest user message:\n")[0]);
        expect(context.photoContext.mode).toBe("angles"); expect(context.photoContext.attachedCount).toBe(3);
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ intent: "draft", reply: "Your photo estimate is ready. I counted the plate once using all three views.", draft: { name: "Lunch plate", calories: 500, fat: 12, protein: 25, carbs: 73, meal: "lunch", category: "healthy", eatenAtLocal: context.localDateTime, targetEntryId: null, assumptions: "One lunch plate, seen from three angles." } }) }] } }], usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 200 } });
      } });
      await route.fulfill({ json: next });
    } catch (error) { await route.fulfill({ status: 503, json: { message: error instanceof Error ? error.message : "Unavailable" } }); }
  });
  await chatLogin(page);
  const images = await Promise.all(["#b7cc9d", "#ccb79d", "#b79dcc"].map(async (background, index) => ({ name: `lunch-${index}.png`, mimeType: "image/png", buffer: await sharp({ create: { width: 1600, height: 1200, channels: 3, background } }).png().toBuffer() })));
  await page.getByLabel("Upload food photo", { exact: true }).setInputFiles(images.slice(0, 2));
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(2);
  await page.getByLabel("Take food photo", { exact: true }).setInputFiles(images[2]);
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(3);
  await page.getByRole("button", { name: "Remove photo 2", exact: true }).click();
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(2);
  await page.getByLabel("Upload food photo", { exact: true }).setInputFiles(images[1]);
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(3);
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>(".chat-photo-thumb img")).every(image => image.complete && image.naturalWidth > 0));
  await page.getByLabel("Photos show", { exact: true }).selectOption("angles");
  await page.getByLabel("Your message", { exact: true }).fill("My lunch today, three views of the same plate");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const sendBox = await page.getByRole("button", { name: "Send message", exact: true }).boundingBox(), navBox = await page.getByRole("navigation", { name: "Main navigation" }).boundingBox();
  expect(sendBox!.y + sendBox!.height).toBeLessThan(navBox!.y);
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-chat-photo-attachments.png`, fullPage: true });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("region", { name: "Kay", exact: true }).getByRole("alert")).toContainText("unavailable right now");
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(3);
  await expect(page.getByLabel("Photos show", { exact: true })).toHaveValue("angles");
  await expect(page.getByLabel("Your message", { exact: true })).toHaveValue("My lunch today, three views of the same plate");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review meal", exact: true })).toBeVisible();
  expect(requestIds).toHaveLength(2); expect(requestIds[0]).toBe(requestIds[1]);
  await expect(page.getByRole("article", { name: "Your chat message", exact: true })).toHaveCount(1);
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(0);
  await expect(page.getByText("3 photos attached · Same food, different angles", { exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Food", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "AI", exact: true }).click();
  await expect(page.getByText("3 photos attached · Same food, different angles", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Hi, I’m Kay.", exact: true })).toBeVisible();
  await expect(page.getByText("3 photos attached · Same food, different angles", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-chat-photo.png`, fullPage: true });
});

test("food chat enforces the photo limit without losing selected photos", async ({ page }) => {
  await db.execute("DELETE FROM \"foodChat\" WHERE \"userId\" = $1", [memberId]);
  await chatLogin(page);
  const buffer = await sharp({ create: { width: 60, height: 60, channels: 3, background: "#aabbcc" } }).png().toBuffer();
  const photos = Array.from({ length: 5 }, (_, index) => ({ name: `photo-${index}.png`, mimeType: "image/png", buffer }));
  await page.getByLabel("Upload food photo", { exact: true }).setInputFiles(photos);
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(5);
  await page.getByLabel("Upload food photo", { exact: true }).setInputFiles(photos[0]);
  await expect(page.getByRole("region", { name: "Kay", exact: true }).getByRole("alert")).toContainText("up to 5 photos");
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(5);
  await page.getByRole("button", { name: "Remove photo 3", exact: true }).click();
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(4);
  await page.getByLabel("Upload food photo", { exact: true }).setInputFiles({ name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from("Not a photo") });
  await expect(page.getByRole("region", { name: "Kay", exact: true }).getByRole("alert")).toContainText("Choose a JPEG");
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(4);
  await page.getByLabel("Upload food photo", { exact: true }).setInputFiles(photos[0]);
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(5);
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>(".chat-photo-thumb img")).every(image => image.complete && image.naturalWidth > 0));
  await page.getByLabel("Photos show", { exact: true }).selectOption("meal");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("profile edits persist and return to the same tab without losing journal or chat state", async ({ page }, info) => {
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("link", { name: "Food", exact: true }).click();
  await page.getByLabel("Journal date", { exact: true }).fill("2020-01-22");
  await page.getByRole("button", { name: "Open profile", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "Profile", exact: true });
  await expect(profile.getByLabel("Name", { exact: true })).toHaveValue("Test Member");
  await expect(profile.getByLabel("Email", { exact: true })).toHaveValue(memberEmail);
  await expect(profile.getByLabel("Email", { exact: true })).toHaveJSProperty("readOnly", true);
  await expect(profile.getByLabel("Age (years)", { exact: true })).toHaveValue("");
  await expect(profile.getByLabel("Sex", { exact: true })).toHaveValue("");
  await expect(profile.getByLabel("Height (cm)", { exact: true })).toHaveValue("");
  await expect(profile.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  if (info.project.name === "mobile") {
    const bounds = (await profile.boundingBox())!;
    expect(bounds.x).toBe(0);
    expect(bounds.width).toBe(await page.evaluate(() => innerWidth));
  }
  await profile.getByLabel("Name", { exact: true }).fill("Jordan Bloom");
  await profile.getByLabel("Age (years)", { exact: true }).fill("34");
  await profile.getByLabel("Sex", { exact: true }).selectOption("intersex");
  await profile.getByLabel("Height (cm)", { exact: true }).fill("175.5");
  await profile.getByLabel("Weight (kg)", { exact: true }).fill("78.5");
  await profile.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(profile.getByRole("status")).toHaveText("Profile saved.");
  await expect(page.locator("#main-content h1").filter({ hasText: "Hi, Jordan." })).toHaveCount(1);
  await expect(page).toHaveURL(/profile=1/);
  await expect(page.locator(".account-actions .avatar")).toHaveText("J");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-profile.png` });
  await profile.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(profile).not.toBeVisible();
  await expect(navigation.getByRole("link", { name: "Food", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Journal date", { exact: true })).toHaveValue("2020-01-22");
  await navigation.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hi, Jordan.", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open profile", exact: true }).click();
  await expect(profile.getByLabel("Age (years)", { exact: true })).toHaveValue("34");
  await expect(profile.getByLabel("Sex", { exact: true })).toHaveValue("intersex");
  await expect(profile.getByLabel("Height (cm)", { exact: true })).toHaveValue("175.5");
  await expect(profile.getByLabel("Weight (kg)", { exact: true })).toHaveValue("78.5");
  await page.goBack();
  await expect(profile).not.toBeVisible();
  await page.goForward();
  await expect(profile.getByLabel("Name", { exact: true })).toHaveValue("Jordan Bloom");
  await profile.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(profile).not.toBeVisible();
  await navigation.getByRole("link", { name: "AI", exact: true }).click();
  await expect(page.getByLabel("Your message", { exact: true })).toBeEnabled();
  await page.getByLabel("Your message", { exact: true }).fill("An unsent meal note");
  await page.getByRole("button", { name: "Open profile", exact: true }).click();
  await expect(profile.getByLabel("Name", { exact: true })).toHaveValue("Jordan Bloom");
  await profile.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.getByLabel("Your message", { exact: true })).toHaveValue("An unsent meal note");
  await page.goto("/app?tab=food&profile=1");
  await expect(profile.getByLabel("Name", { exact: true })).toHaveValue("Jordan Bloom");
  await profile.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(profile).not.toBeVisible();
  await expect(navigation.getByRole("link", { name: "Food", exact: true })).toHaveAttribute("aria-current", "page");
});

test("administrator avatar opens the private profile and returns to administration", async ({ page }) => {
  await page.goto("/admin");
  await page.getByLabel("Email address", { exact: true }).fill(adminEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Open profile", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "Profile", exact: true });
  await expect(profile.getByLabel("Name", { exact: true })).toHaveValue("Browser Administrator");
  await expect(profile.getByLabel("Email", { exact: true })).toHaveValue(adminEmail);
  await profile.getByRole("button", { name: "Back to admin", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Hello, Browser.", exact: true })).toBeVisible();
});

test("preset avatars preview, persist across reloads, reset to initials, and sign out from Profile", async ({ page }, info) => {
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const header = page.locator(".app-header"), portrait = header.locator(".avatar [data-avatar-id]");
  await expect(header.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
  await header.getByRole("button", { name: "Open profile", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "Profile", exact: true });
  await expect(profile.getByRole("radio")).toHaveCount(6);
  const initial = await portrait.getAttribute("data-avatar-id");
  for (const [label, id] of [["Apple", "apple"], ["Sprout", "sprout"], ["Cat", "cat"], ["Bear", "bear"], ["Bunny", "bunny"], ["Panda", "panda"]]) {
    await profile.getByRole("radio", { name: label, exact: true }).check();
    await expect(profile.locator(".profile-avatar-preview [data-avatar-id]")).toHaveAttribute("data-avatar-id", id);
    await expect(portrait).toHaveAttribute("data-avatar-id", initial!);
  }
  await profile.getByRole("radio", { name: "Bunny", exact: true }).check();
  await profile.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(profile.getByRole("status")).toHaveText("Profile saved.");
  await expect(portrait).toHaveAttribute("data-avatar-id", "bunny");
  await profile.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(profile).not.toBeVisible();
  await page.reload();
  await expect(portrait).toHaveAttribute("data-avatar-id", "bunny");
  await header.getByRole("button", { name: "Open profile", exact: true }).click();
  await expect(profile.getByRole("radio", { name: "Bunny", exact: true })).toBeChecked();
  await profile.getByRole("radio", { name: "Panda", exact: true }).check();
  await profile.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(profile).not.toBeVisible();
  await expect(portrait).toHaveAttribute("data-avatar-id", "bunny");
  await header.getByRole("button", { name: "Open profile", exact: true }).click();
  await expect(profile.getByRole("radio", { name: "Bunny", exact: true })).toBeChecked();
  await profile.getByRole("button", { name: "Use initials", exact: true }).click();
  await profile.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(portrait).toHaveAttribute("data-avatar-id", "initials");
  await profile.getByRole("radio", { name: "Apple", exact: true }).check();
  await profile.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(profile.getByRole("status")).toHaveText("Profile saved.");
  await expect(portrait).toHaveAttribute("data-avatar-id", "apple");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-profile-avatars.png` });
  await profile.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
});

test("AI goal help prefills chat, proposes editable goals and saves only after final confirmation", async ({ page }, info) => {
  await db.execute('DELETE FROM "foodGoalVersion" WHERE "userId" = $1', [memberId]);
  await db.execute('DELETE FROM "foodGoal" WHERE "userId" = $1', [memberId]);
  let calls = 0;
  await page.route("**/api/food/chat", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const data = await mockedChatInput(route);
    const next = await sendFoodChat(memberId, data, { settings: chatSettings, fetcher: async () => {
      calls++;
      const value = calls === 1
        ? { intent: "reply", reply: "What is your weight, activity level and objective?", draft: null, goalDraft: null }
        : { intent: "goals", reply: "Here is a starting range. Review it before saving.", draft: null, goalDraft: { goals: suggestedFoodGoals(2200, 2500), effectiveFrom: "2021-01-01", assumptions: "Based on the details you provided." } };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 250 } });
    } });
    await route.fulfill({ json: next });
  });
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Food", exact: true }).click();
  await page.getByRole("button", { name: "Set goals", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Daily food goals" });
  await expect(dialog.getByRole("button", { name: "Use suggested macros", exact: true })).toHaveCount(0);
  await dialog.getByLabel("Apply from", { exact: true }).fill("2021-01-01");
  await dialog.getByRole("button", { name: "Take help from AI" }).click();
  await expect(dialog).toHaveCount(0);
  const input = page.getByLabel("Your message", { exact: true });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(/Help me set daily calorie/);
  await expect(input).toHaveValue(/2021-01-01/);
  await expect(input).not.toHaveValue(/2200|2500|draft ranges/i);
  expect(calls).toBe(0);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("What is your weight, activity level and objective?", { exact: true })).toBeVisible();
  await input.fill("I weigh 75 kg, walk daily and want to maintain my weight.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review goals", exact: true })).toBeVisible();
  expect(await page.locator(".chat-goal-draft").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-ai-goal-proposal.png`, fullPage: true });
  await page.getByRole("button", { name: "Review goals", exact: true }).click();
  await expect(dialog.getByLabel("Minimum calories (kcal)", { exact: true })).toHaveValue("2200");
  expect((await db.execute<DatabaseRow[]>('SELECT * FROM "foodGoalVersion" WHERE "userId" = $1', [memberId]))[0]).toHaveLength(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await nav.getByRole("link", { name: "Food", exact: true }).click();
  await expect(page.getByText("No goal set for this date.", { exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "Review goals", exact: true }).click();
  await dialog.getByLabel("Maximum calories (kcal)", { exact: true }).fill("2600");
  await dialog.getByLabel("Maximum protein (g)", { exact: true }).fill("400");
  await expect(dialog.getByText(/Maximum macros suggest about/)).toBeVisible();
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-ai-goal-review.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Save goals", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review goals", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Saved goals", { exact: true })).toContainText("Saved");
  await nav.getByRole("link", { name: "Food", exact: true }).click();
  await expect(page.getByRole("progressbar", { name: "Calories goal", exact: true })).toHaveAttribute("aria-valuemax", "2600");
  await page.getByRole("button", { name: "Edit goals", exact: true }).click();
  await expect(dialog.getByLabel("Maximum protein (g)", { exact: true })).toHaveValue("400");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("admin entry stays at /admin, member screens have no admin links, and administrators manage roles", async ({ page }, info) => {
  const email = `managed-browser-${randomUUID()}@example.com`;
  try {
    await page.goto("/login");
    await expect(page.getByRole("link", { name: "Admin sign in", exact: true })).toHaveCount(0);
    await page.goto("/admin");
    await page.getByLabel("Email address", { exact: true }).fill(adminEmail);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your community", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/admin$/);
    await page.getByRole("button", { name: "Create administrator", exact: true }).click();
    const create = page.getByRole("dialog", { name: "Create administrator", exact: true });
    await create.getByLabel("Name", { exact: true }).fill("New Administrator");
    await create.getByLabel("Email address", { exact: true }).fill(email);
    await create.getByLabel("Initial password", { exact: true }).fill(password);
    await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-create-admin.png`, fullPage: true });
    await create.getByRole("button", { name: "Create admin", exact: true }).click();
    await expect(create).toHaveCount(0);
    await page.getByLabel("Search accounts", { exact: true }).fill(email);
    await expect(page.getByRole("cell", { name: "Administrator", exact: true })).toBeVisible();
    await page.getByRole("button", { name: `Make member: ${email}`, exact: true }).click();
    await page.getByRole("dialog", { name: "Make member", exact: true }).getByRole("button", { name: "Confirm change" }).click();
    await expect(page.getByRole("cell", { name: "Member", exact: true })).toBeVisible();
    await page.getByRole("button", { name: `Make administrator: ${email}`, exact: true }).click();
    await page.getByRole("dialog", { name: "Make administrator", exact: true }).getByRole("button", { name: "Confirm change" }).click();
    await expect(page.getByRole("cell", { name: "Administrator", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-admin-management.png`, fullPage: true });
    await page.getByRole("link", { name: "Your space", exact: true }).click();
    await expect(page.getByRole("link", { name: "Community", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open administration", exact: true })).toHaveCount(0);
  } finally { await db.execute('DELETE FROM "user" WHERE email = $1', [email]); }
});

test("AI credit balance shows approximate replies and contact, updates after replies, and survives new chat", async ({ page }, info) => {
  await page.route("**/api/food/chat", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const next = await sendFoodChat(memberId, await mockedChatInput(route), { settings: chatSettings, fetcher: async () => Response.json({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ intent: "reply", reply: "I can help you with your food goals.", draft: null, goalDraft: null }) }] } }],
      usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 500 },
    }) });
    await route.fulfill({ json: next });
  });
  await chatLogin(page);
  const current = await (await page.request.get("/api/credits")).json();
  const balance = page.getByRole("button", { name: "View AI credits", exact: true });
  await expect(balance).toContainText(current.available.toFixed(2));
  await balance.click();
  const wallet = page.getByRole("dialog", { name: "AI credits", exact: true });
  await expect(wallet.locator(".credit-total strong")).toHaveText(current.available.toFixed(2));
  await expect(wallet.locator(".credit-estimate")).toContainText(/About \d+ replies remaining/);
  await expect(wallet.locator(".credit-facts")).toHaveCount(0);
  await expect(wallet).not.toContainText(/multiplier|Current rate|Maximum per reply|temporarily reserved|₹1|\d+(?:\.\d+)?×/);
  await expect(wallet.getByRole("heading", { name: "Credit additions", exact: true })).toBeVisible();
  await wallet.getByRole("button", { name: "Add credits", exact: true }).click();
  await expect(wallet.getByRole("link", { name: /Koshan Qari on LinkedIn/ })).toHaveAttribute("href", "https://in.linkedin.com/in/koshanqari");
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-credit-wallet.png`, fullPage: true });
  await wallet.getByRole("button", { name: "Close credits", exact: true }).click();
  await page.getByLabel("Your message", { exact: true }).fill("Can you help with my food goals?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("I can help you with your food goals.", { exact: true })).toBeVisible();
  const afterReply = await (await page.request.get("/api/credits")).json();
  expect(afterReply.available).toBeLessThan(current.available);
  await expect(balance).toContainText(afterReply.available.toFixed(2));
  await balance.click();
  await expect(wallet.getByRole("heading", { name: "Credit additions", exact: true })).toBeVisible();
  await expect(wallet.locator(".credit-history")).not.toContainText("AI reply");
  const history = await (await page.request.get("/api/credits")).json();
  expect(history.transactions.every((item: { amount: number; kind: string }) => item.amount > 0 && ["welcome", "topup", "refund"].includes(item.kind))).toBe(true);
  await wallet.getByRole("button", { name: "Close credits", exact: true }).click();

  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hi, I’m Kay.", exact: true })).toBeVisible();
  await expect(balance).toContainText(afterReply.available.toFixed(2));
  await db.execute('UPDATE "creditWallet" SET "balanceCents" = 0 WHERE "userId" = $1', [memberId]);
  await page.reload();
  await expect(balance).toContainText("0.00");
  await page.getByLabel("Your message", { exact: true }).fill("This must not use the provider");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await balance.click();
  await expect(wallet.locator(".credit-estimate")).toContainText("About 0 replies remaining");
  await wallet.getByRole("button", { name: "Close credits", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Food", exact: true }).click();
  await expect(page.getByRole("button", { name: "Log food", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("admin credit controls add an offline top-up, change user pricing and show an audit history", async ({ page }, info) => {
  await page.goto("/admin");
  await page.getByLabel("Email address", { exact: true }).fill(adminEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Search accounts", { exact: true }).fill(memberEmail);
  await page.getByRole("button", { name: `Manage credits: ${memberEmail}`, exact: true }).click();
  const wallet = page.getByRole("dialog", { name: /Credits ·/ });
  await expect(wallet.locator(".credit-total strong")).toBeVisible();
  await wallet.getByText("How multipliers work", { exact: true }).click();
  await expect(wallet.getByText(/50 ÷ 150 ÷ 0.10 = 3.33×/)).toBeVisible();
  await expect(wallet.getByText(/Changing a rate affects future replies/)).toBeVisible();
  const initial = Number((await wallet.locator(".credit-total strong").innerText()).replaceAll(",", ""));
  await wallet.getByLabel("Credits to add", { exact: true }).fill("50");
  await wallet.getByLabel("Money received (₹, optional)", { exact: true }).fill("50");
  await wallet.getByLabel("Reason or payment reference", { exact: true }).fill("Offline payment reference fixture");
  await wallet.getByRole("button", { name: "Confirm credits", exact: true }).click();
  await expect(wallet.locator(".credit-total strong")).toHaveText((initial + 50).toFixed(2));
  await expect(wallet.locator(".credit-history")).toContainText("Offline payment reference fixture");
  await expect(wallet.getByLabel("Credits to add", { exact: true })).toHaveValue("");
  await expect(wallet.getByLabel("Action", { exact: true }).locator("option")).toHaveCount(2);
  await wallet.getByRole("button", { name: "Close credits", exact: true }).click();
  await page.getByRole("button", { name: `Change multiplier: ${memberEmail}`, exact: true }).click();
  const pricing = page.getByRole("dialog", { name: /Multiplier ·/ });
  await expect(pricing.getByLabel("Action", { exact: true })).toHaveCount(0);
  await pricing.getByLabel("Multiplier", { exact: true }).fill("3.5");
  await pricing.getByLabel("Reason or payment reference", { exact: true }).fill("Updated personal rate");
  await pricing.getByRole("button", { name: "Save multiplier", exact: true }).click();
  await expect(pricing.locator(".credit-facts")).toContainText("3.50×");
  await expect(pricing.locator(".credit-history")).toContainText("Updated personal rate");
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-admin-credits.png`, fullPage: true });
  await pricing.getByRole("button", { name: "Close credits", exact: true }).click();
  await expect(page.getByRole("button", { name: `Change multiplier: ${memberEmail}`, exact: true })).toContainText("3.50×");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Leave later scenarios at the default rate.
  await db.execute('UPDATE "creditWallet" SET "multiplierHundred" = 200 WHERE "userId" = $1', [memberId]);
});

test("shared AI limits explain the pause without claiming that user credits are exhausted", async ({ page }) => {
  let monthly = false;
  await page.route("**/api/food/chat*", async route => {
    if (route.request().method() === "POST") return route.fallback();
    const response = await route.fetch(), body = await response.json();
    if (response.ok()) body.quota = { ...body.quota, configured: true, remainingToday: monthly ? 50 : 0, remainingBudgetUsd: monthly ? 0 : .99, credits: { balance: 20, available: 20, estimatedReplies: 61, canSend: true } };
    await route.fulfill({ response, json: body });
  });
  await chatLogin(page);
  await expect(page.getByRole("button", { name: "View AI credits", exact: true })).toContainText("20.00");
  await expect(page.getByText("Kay’s shared daily limit is reached. Your credits are unchanged.", { exact: true })).toBeVisible();
  await page.getByLabel("Your message", { exact: true }).fill("I still have credits");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  monthly = true;
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByText("Kay’s shared spending limit is reached. Your credits are unchanged.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "View AI credits", exact: true })).toContainText("20.00");
});

test("resuming Kay refreshes a stale allowance without clearing unsent text or photos", async ({ page }) => {
  await page.clock.install();
  let blocked = true, resets = 0, reads = 0;
  await page.route("**/api/food/chat*", async route => {
    if (route.request().method() === "POST") return route.fallback();
    if (route.request().method() === "DELETE") resets++; else reads++;
    const response = await route.fetch(), body = await response.json();
    if (response.ok()) body.quota = { ...body.quota, configured: true, remainingToday: blocked ? 0 : 40, remainingBudgetUsd: .99, credits: { balance: 20, available: 20, estimatedReplies: 61, canSend: true } };
    await route.fulfill({ response, json: body });
  });
  await chatLogin(page);
  const note = page.getByLabel("Your message", { exact: true });
  await note.fill("Keep my unsent meal note");
  const photo = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#aabb88" } }).png().toBuffer();
  await page.getByLabel("Upload food photo", { exact: true }).setInputFiles({ name: "meal.png", mimeType: "image/png", buffer: photo });
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  blocked = false;
  await page.clock.fastForward(31_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect(note).toHaveValue("Keep my unsent meal note");
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(1);
  expect(reads).toBeGreaterThan(0); expect(resets).toBe(1);
});

test("a new release offers a session-preserving update and protects in-flight replies and unsent photos", async ({ page }, info) => {
  await page.clock.install();
  const response = await page.request.get("/api/version");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const currentRelease = (await response.json()).release;
  let remoteRelease = currentRelease;
  await page.route("**/api/version*", async route => {
    expect(route.request().headers()["x-daywell-release"]).toBe(currentRelease);
    await route.fulfill({ json: { release: remoteRelease }, headers: { "Cache-Control": "no-store" } });
  });
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/food/chat", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const next = await sendFoodChat(memberId, await mockedChatInput(route), { settings: chatSettings, fetcher: async () => {
      started(); await held;
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ intent: "reply", reply: "Ready to keep logging.", draft: null, goalDraft: null }) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } });
    } });
    await route.fulfill({ json: next });
  });
  await chatLogin(page);
  const originalUser = (await (await page.request.get("/api/account")).json()).user.id;
  await page.getByLabel("Your message", { exact: true }).fill("Help with my meal");
  await page.getByRole("button", { name: "Send message", exact: true }).click(); await ready;
  try {
    remoteRelease = currentRelease + "-next";
    await page.clock.fastForward(31_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("A new version is ready.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Update app", exact: true }).click();
    await expect(page.getByText("Please wait for your current action to finish.", { exact: true })).toBeVisible();
  } finally { release(); }
  await expect(page.getByText("Ready to keep logging.", { exact: true })).toBeVisible();
  const note = page.getByLabel("Your message", { exact: true });
  await note.fill("Do not lose this note");
  const photo = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#aabb88" } }).png().toBuffer();
  await page.getByLabel("Upload food photo", { exact: true }).setInputFiles({ name: "meal.png", mimeType: "image/png", buffer: photo });
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(1);
  page.once("dialog", async dialog => { expect(dialog.message()).toContain("selected photos"); await dialog.dismiss(); });
  await page.getByRole("button", { name: "Update app", exact: true }).click();
  await expect(note).toHaveValue("Do not lose this note");
  await expect(page.locator(".chat-photo-thumb img")).toHaveCount(1);
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-app-update.png`, fullPage: true });
  await page.getByRole("button", { name: "Later", exact: true }).click();
  await expect(page.getByText("A new version is ready.", { exact: true })).toHaveCount(0);
  await expect(note).toHaveValue("Do not lose this note");
  remoteRelease = currentRelease + "-another";
  await page.clock.fastForward(31_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("A new version is ready.", { exact: true })).toBeVisible();
  remoteRelease = currentRelease;
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Update app", exact: true }).click();
  await expect(page).toHaveURL(/\/app\?tab=chat$/);
  await expect(page.getByLabel("Your message", { exact: true })).toBeEnabled();
  expect((await (await page.request.get("/api/account")).json()).user.id).toBe(originalUser);
});

test("admin can save new account defaults and reload without changing an existing wallet", async ({ page }, info) => {
  const original = await getCreditDefaults();
  const [admins] = await db.execute<DatabaseRow[]>('SELECT id FROM "user" WHERE email = $1', [adminEmail]);
  const [before] = await db.execute<DatabaseRow[]>('SELECT "balanceCents", "multiplierHundred" FROM "creditWallet" WHERE "userId" = $1', [memberId]);
  try {
    await page.goto("/admin");
    await page.getByLabel("Email address", { exact: true }).fill(adminEmail);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const form = page.getByRole("form", { name: "New account defaults", exact: true });
    await expect(form.getByLabel("Welcome credits", { exact: true })).toHaveValue(String(original.welcomeCredits));
    await form.getByLabel("Welcome credits", { exact: true }).fill("65");
    await form.getByLabel("Default multiplier", { exact: true }).fill("2.75");
    await form.getByRole("button", { name: "Save defaults", exact: true }).click();
    await expect(form.getByRole("status")).toContainText("New signups will use these values");
    await page.reload();
    await expect(form.getByLabel("Welcome credits", { exact: true })).toHaveValue("65");
    await expect(form.getByLabel("Default multiplier", { exact: true })).toHaveValue("2.75");
    const [after] = await db.execute<DatabaseRow[]>('SELECT "balanceCents", "multiplierHundred" FROM "creditWallet" WHERE "userId" = $1', [memberId]);
    expect(after).toEqual(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-signup-defaults.png`, fullPage: true });
  } finally {
    const latest = await getCreditDefaults();
    await saveCreditDefaults(admins[0].id, { ...original, revision: latest.revision });
  }
});


test("admin sidebar opens cost docs, supports direct links and preserves unsaved defaults between tabs", async ({ page }, info) => {
  await page.goto("/admin");
  await page.getByLabel("Email address", { exact: true }).fill(adminEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const navigation = page.getByRole("navigation", { name: "Administration", exact: true });
  await expect(navigation.getByRole("link", { name: "Community", exact: true })).toHaveAttribute("aria-current", "page");
  const form = page.getByRole("form", { name: "New account defaults", exact: true });
  await form.getByLabel("Welcome credits", { exact: true }).fill("77");
  const requests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/admin") requests.push(request.url()); });
  await navigation.getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\?tab=docs$/);
  await expect(page.getByRole("heading", { name: "Cost calculation", exact: true })).toBeVisible();
  await expect(form).toBeHidden();
  const docs = page.getByRole("article", { name: "Cost calculation", exact: true });
  await expect(docs).toContainText("36 successful production requests");
  await expect(docs.getByRole("row", { name: "Input API cost $0.25 ₹23.34", exact: true })).toBeVisible();
  await expect(docs).toContainText("2,488.50");
  await expect(docs).toContainText("₹100.00");
  await expect(docs).toContainText("GST is not added separately");
  expect(requests).toEqual([]);
  await page.goBack();
  await expect(form.getByLabel("Welcome credits", { exact: true })).toHaveValue("77");
  await navigation.getByRole("link", { name: "Docs", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Cost calculation", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Docs", exact: true })).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const sidebarTop = await navigation.evaluate(element => element.getBoundingClientRect().top);
  const content = page.getByRole("main");
  await content.evaluate(element => { element.scrollTop = 400; });
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await navigation.evaluate(element => element.getBoundingClientRect().top)).toBe(sidebarTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(navigation.getByRole("link", { name: "Docs", exact: true })).toBeInViewport();
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-admin-docs-scroll.png`, fullPage: true });
  await content.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-admin-cost-docs.png`, fullPage: true });
});


test("admin can view a member read-only and exit without replacing either account session", async ({ page }, info) => {
  await db.execute(`INSERT INTO "foodEntry" (id, "userId", name, calories, protein, carbs, fat, category, "eatenAtLocal", "timeZone")
    VALUES ($1, $2, 'Private view meal', 400, 25, 45, 13, 'healthy', $3, 'Asia/Kolkata')`, [randomUUID(), memberId, localDateTime().slice(0, 10) + "T12:00"]);
  const [targets] = await db.execute<DatabaseRow[]>('SELECT name FROM "user" WHERE id = $1', [memberId]);
  const targetName = String(targets[0].name);
  const [originalChats] = await db.execute<DatabaseRow[]>('SELECT * FROM "foodChat" WHERE "userId" = $1', [memberId]);
  await page.goto("/admin");
  await page.getByLabel("Email address", { exact: true }).fill(adminEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Search accounts", { exact: true })).toBeVisible();
  const admin = (await (await page.request.get("/api/account")).json()).user;
  await page.getByLabel("Search accounts", { exact: true }).fill(memberEmail);
  await page.getByRole("button", { name: `View as user: ${memberEmail}`, exact: true }).click();
  await expect(page).toHaveURL(/\/app\?view=[a-f0-9]{64}$/);
  const banner = page.getByRole("complementary", { name: "Admin viewing session", exact: true });
  await expect(banner).toContainText(`Viewing as ${targetName}`);
  await expect(banner).toContainText("Read-only");
  await expect(page.getByRole("heading", { name: `Hi, ${targetName.trim().split(/\s+/)[0]}.`, exact: true })).toBeVisible();
  const writes: string[] = [];
  page.on("request", request => { if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && /^\/api\/(food|account|credits)/.test(new URL(request.url()).pathname)) writes.push(request.url()); });
  await page.getByRole("button", { name: "Open profile", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "Profile", exact: true });
  await expect(profile.getByLabel("Name", { exact: true })).toBeDisabled();
  await expect(profile.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await expect(profile.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
  await profile.getByRole("button", { name: "Back to app", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Food", exact: true }).click();
  await expect(page).toHaveURL(/view=[a-f0-9]{64}/);
  await expect(page.getByText("Private view meal", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log food", exact: true })).toBeDisabled();
  for (const button of await page.getByRole("button", { name: "Edit", exact: true }).all()) await expect(button).toBeDisabled();
  await expect(page.getByRole("button", { name: /^(Set|Edit) goals$/ })).toBeDisabled();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "AI", exact: true }).click();
  await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Your message", { exact: true })).toHaveCount(0);
  const [chats] = await db.execute<DatabaseRow[]>('SELECT * FROM "foodChat" WHERE "userId" = $1', [memberId]);
  expect(chats).toEqual(originalChats);
  expect(writes).toEqual([]);
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-view-as-user.png`, fullPage: true });
  await banner.getByRole("button", { name: "Exit view", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  expect((await (await page.request.get("/api/account")).json()).user.id).toBe(admin.id);
});


test("Kay proposes editable age, sex, height and weight updates and saves only after confirmation", async ({ page }, info) => {
  await db.execute('DELETE FROM "userProfile" WHERE "userId" = $1', [memberId]);
  let requestCount = 0;
  await page.route("**/api/food/chat*", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const next = await sendFoodChat(memberId, await mockedChatInput(route), { settings: chatSettings, fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const context = JSON.parse(body.contents[0].parts[0].text.split("Application context (saved records are authoritative):\n")[1].split("\nLatest user message:")[0]);
      requestCount++;
      if (requestCount > 1) expect(context.userProfile.weightKg).toBe(77.5);
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ intent: "profile", reply: "Please review your profile update.", draft: null, goalDraft: null, profileDraft: { changes: requestCount === 1 ? { age: 28, sex: "male", heightCm: 175, weightKg: 78 } : { weightKg: 76 }, assumptions: "Details you supplied." } }) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } });
    } });
    await route.fulfill({ json: next });
  });
  await chatLogin(page);
  await page.getByLabel("Your message", { exact: true }).fill("I am 28, male, 175 cm and 78 kg");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const proposal = page.getByRole("form", { name: "Profile update", exact: true });
  await expect(proposal.getByLabel("Weight (kg)", { exact: true })).toHaveValue("78");
  let profile = (await (await page.request.get("/api/account")).json()).user;
  expect(profile.weightKg).toBe(null); expect(profile.age).toBe(null);
  await proposal.getByLabel("Weight (kg)", { exact: true }).fill("77.5");
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-profile-proposal.png`, fullPage: true });
  await proposal.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByText("Profile saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open profile", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Profile", exact: true });
  await expect(dialog.getByLabel("Age (years)", { exact: true })).toHaveValue("28");
  await expect(dialog.getByLabel("Weight (kg)", { exact: true })).toHaveValue("77.5");
  await expect(dialog.getByLabel("Date of birth", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Back to app", exact: true }).click();
  await page.getByLabel("Your message", { exact: true }).fill("My weight is now 76 kg");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const latest = page.getByRole("form", { name: "Profile update", exact: true }).filter({ has: page.getByRole("button", { name: "Save profile", exact: true }) });
  await expect(latest.getByLabel("Weight (kg)", { exact: true })).toHaveValue("76");
  await expect(latest.getByLabel("Age (years)", { exact: true })).toHaveCount(0);
  await latest.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByText("Profile saved.", { exact: true })).toHaveCount(2);
  profile = (await (await page.request.get("/api/account")).json()).user;
  expect(profile.weightKg).toBe(76); expect(profile.age).toBe(28); expect(profile.heightCm).toBe(175); expect(profile.sex).toBe("male");
});

test("activity logger supports all types, independent fields, goals and history without overflow", async ({ page }, info) => {
  await db.execute('DELETE FROM "activityEntry" WHERE "userId"=$1', [memberId]);
  await db.execute('DELETE FROM "activityGoalVersion" WHERE "userId"=$1', [memberId]);
  await chatLogin(page);
  const profileResponse = await page.request.patch("/api/account", { headers: { Origin: baseURL }, data: { age: 30, weightKg: 70, heightCm: 175 } }); expect(profileResponse.status()).toBe(200);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Activity history", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Log activity", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Log activity", exact: true });
  for (const type of ["walking", "running", "cycling", "swimming", "strength", "badminton", "cricket", "football", "hiking", "others"]) {
    await dialog.getByLabel("Activity", { exact: true }).selectOption(type);
    await expect(dialog.getByLabel("Duration", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Pace", { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("Speed", { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("Steps", { exact: true })).toHaveCount(["walking", "running", "hiking"].includes(type) ? 1 : 0);
    await expect(dialog.getByLabel("Distance", { exact: true })).toHaveCount(["walking", "running", "cycling", "swimming", "hiking"].includes(type) ? 1 : 0);
    if (type === "others") { await expect(dialog.getByLabel("Active calories", { exact: true })).toBeVisible(); await expect(dialog.getByLabel("Calories", { exact: true })).toHaveValue("manual"); }
  }
  await dialog.getByLabel("Activity", { exact: true }).selectOption("walking");
  await dialog.getByLabel("Logging", { exact: true }).selectOption("daily_total");
  await expect(dialog.getByLabel("Duration", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Distance", { exact: true })).toBeVisible();
  await dialog.getByLabel("Steps", { exact: true }).fill("3000");
  await expect(dialog.getByRole("status")).toContainText("76.26 kcal");
  await dialog.getByLabel("Logging", { exact: true }).selectOption("session");
  await dialog.getByLabel("Duration", { exact: true }).fill("60");
  await dialog.getByLabel("Distance", { exact: true }).fill("5");
  await dialog.getByLabel("Steps", { exact: true }).fill("6000");
  await expect(dialog.getByRole("status")).toContainText("205.8 kcal");
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-activity-form.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Save activity", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".activity-entries article")).toHaveCount(1);
  await page.getByRole("button", { name: "Set goals", exact: true }).click();
  const goals = page.getByRole("dialog", { name: "Daily activity goals", exact: true });
  await goals.getByLabel("Logged active calories", { exact: true }).fill("200");
  await goals.getByLabel("Steps", { exact: true }).fill("5000");
  await goals.getByLabel("Active minutes", { exact: true }).fill("30");
  await goals.getByRole("button", { name: "Save goals", exact: true }).click();
  await expect(goals).not.toBeVisible();
  await expect(page.locator(".activity-summary small").filter({ hasText: "Goal achieved" })).toHaveCount(3);
  const history = page.getByRole("region", { name: "Activity goal history", exact: true });
  const today = await page.getByLabel("Activity date", { exact: true }).inputValue();
  await expect(history.locator(`[data-date="${today}"]`)).toHaveAttribute("data-status", "achieved");
  const chart = history.getByRole("group", { name: /Daily activity chart/ });
  await chart.focus(); await chart.press("End");
  await expect(history.locator(".history-value")).toContainText("205.8");
  for (const period of ["M", "6M", "Y", "W"]) { await history.getByRole("button", { name: period, exact: true }).click(); await expect(history.locator(".history-canvas svg")).toBeVisible(); }
  await history.getByRole("button", { name: "Steps", exact: true }).click();
  await expect(history.locator(`[data-date="${today}"]`)).toHaveAttribute("data-status", "achieved");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-activity-page.png`, fullPage: true });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit activity", exact: true });
  await edit.getByLabel("Steps", { exact: true }).fill("6500");
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".activity-entries")).toContainText("6,500 steps");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".activity-entries article")).toHaveCount(0);
});

test("Kay activity proposal is editable and saves only on final confirmation", async ({ page }, info) => {
  await db.execute('DELETE FROM "activityEntry" WHERE "userId"=$1', [memberId]);
  await db.execute('INSERT INTO "userProfile" ("userId", age, "weightKg") VALUES ($1,30,70) ON CONFLICT ("userId") DO UPDATE SET age=30, "weightKg"=70', [memberId]);
  await page.route("**/api/food/chat*", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const next = await sendFoodChat(memberId, await mockedChatInput(route), { settings: chatSettings, fetcher: async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ intent: "activity", reply: "Review your badminton session.", draft: null, goalDraft: null, profileDraft: null, activityDraft: { activity: { type: "badminton", name: "Evening badminton", durationMinutes: 45, distanceKm: null, steps: null, detail: "social", calorieSource: "estimated", calories: null, notes: "", occurredAtLocal: "2026-11-10T18:00" } } }) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } }) });
    await route.fulfill({ json: next });
  });
  await chatLogin(page);
  await page.getByLabel("Your message", { exact: true }).fill("I played badminton socially for 45 minutes");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Review activity", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review activity", exact: true });
  await expect(dialog.getByLabel("Activity", { exact: true })).toHaveValue("badminton");
  const [before] = await db.execute('SELECT id FROM "activityEntry" WHERE "userId"=$1', [memberId]); expect(before).toHaveLength(0);
  await dialog.getByLabel("Duration", { exact: true }).fill("30");
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-activity-review.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Save activity", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const [saved] = await db.execute('SELECT data FROM "activityEntry" WHERE "userId"=$1', [memberId]); expect(saved).toHaveLength(1); expect(saved[0].data.durationMinutes).toBe(30); expect(saved[0].data.calories).toBe(165.38);
  await page.getByRole("link", { name: "View activity", exact: true }).click();
  await page.getByLabel("Activity date", { exact: true }).fill("2026-11-10");
  await expect(page.locator(".activity-entries")).toContainText("Evening badminton");
});

test("Kay estimates daily walking calories without duration and updates the same total", async ({ page }, info) => {
  await db.execute('DELETE FROM "activityEntry" WHERE "userId"=$1', [memberId]);
  await db.execute('INSERT INTO "userProfile" ("userId", age, "weightKg", "heightCm") VALUES ($1,30,70,175) ON CONFLICT ("userId") DO UPDATE SET age=30, "weightKg"=70, "heightCm"=175', [memberId]);
  let calls = 0;
  await page.route("**/api/food/chat*", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    calls++;
    const next = await sendFoodChat(memberId, await mockedChatInput(route), { settings: chatSettings, fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); expect(body.systemInstruction.parts[0].text).toContain('a daily step total');
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ intent: "activity", reply: "Review your daily step total.", draft: null, goalDraft: null, profileDraft: null, activityDraft: { activity: { type: "walking", name: "Daily steps", stepScope: "daily_total", steps: calls === 1 ? 10000 : 12000, calorieSource: "estimated", calories: null, durationMinutes: null, distanceKm: null, detail: null, notes: "", occurredAtLocal: localDateTime() } } }) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } });
    } });
    await route.fulfill({ json: next });
  });
  await chatLogin(page);
  for (const message of ["I walked 10K steps today throughout the day", "Actually 12K, total throughout the day"]) {
    await page.getByLabel("Your message", { exact: true }).fill(message);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByRole("button", { name: "Review activity", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Review activity", exact: true });
    await expect(dialog.getByLabel("Duration", { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("Distance", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("status")).toContainText(calls === 1 ? "254.19 kcal" : "305.03 kcal");
    await expect(dialog.getByRole("status")).toContainText("41.5%");
    await dialog.getByRole("button", { name: "Save activity", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  const [rows] = await db.execute('SELECT data FROM "activityEntry" WHERE "userId"=$1', [memberId]); expect(rows).toHaveLength(1); expect(rows[0].data.steps).toBe(12000); expect(rows[0].data.calories).toBe(305.03);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.locator(".activity-summary")).toContainText("12,000");
  await expect(page.locator(".activity-entries")).toContainText("305.03 kcal");
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-daily-steps.png`, fullPage: true });
});

test("badminton with duration asks for effort without an interrupted reply and then offers a review", async ({ page }) => {
  await db.execute('INSERT INTO "userProfile" ("userId", age, "weightKg") VALUES ($1,30,70) ON CONFLICT ("userId") DO UPDATE SET age=30, "weightKg"=70', [memberId]);
  let calls = 0;
  await page.route("**/api/food/chat*", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    calls++;
    const next = await sendFoodChat(memberId, await mockedChatInput(route), { settings: chatSettings, fetcher: async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ intent: "activity", reply: "I've logged this activity.", draft: null, goalDraft: null, profileDraft: null, activityDraft: { activity: { type: "badminton", durationMinutes: 30, detail: calls === 1 ? null : "social", calories: 250, calorieSource: "estimated", occurredAtLocal: localDateTime() } } }) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } }) });
    await route.fulfill({ json: next });
  });
  await chatLogin(page);
  await page.getByLabel("Your message", { exact: true }).fill("i played badminton for 30 min");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Was the badminton social/casual or competitive? I have the 30-minute duration.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Reply interrupted/)).toHaveCount(0);
  await expect(page.getByText(/couldn’t get a usable reply/)).toHaveCount(0);
  await page.getByLabel("Your message", { exact: true }).fill("casual");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Your activity is ready to review. Check the details and press Save activity to log it.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review activity", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review activity", exact: true });
  await expect(dialog.getByLabel("Duration", { exact: true })).toHaveValue("30");
  await expect(dialog.getByRole("status")).toContainText("165.38 kcal");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("activity date selection stays aligned with chart, totals and entries during slow day loads", async ({ page }) => {
  const firstDate = "2026-11-17", emptyDate = "2026-11-18", loggedDate = "2026-11-19";
  await db.execute('DELETE FROM "activityEntry" WHERE "userId"=$1', [memberId]);
  await chatLogin(page);
  for (const [date, calories, name] of [[firstDate, 120, "Earlier walk"], [loggedDate, 890.82, "Thursday activity"]] as const) {
    const response = await page.request.post("/api/activity", { headers: { Origin: baseURL }, data: { id: randomUUID(), activity: { type: "others", name, calorieSource: "manual", calories, occurredAtLocal: date + "T12:00" } } }); expect(response.status()).toBe(201);
  }
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Activity", exact: true }).click();
  const history = page.getByRole("region", { name: "Activity goal history", exact: true });
  await page.getByLabel("Activity date", { exact: true }).fill(loggedDate);
  await expect(page.locator(".activity-entries")).toContainText("Thursday activity");
  await history.getByRole("button", { name: "M", exact: true }).click();
  await history.getByRole("button", { name: "Steps", exact: true }).click();
  await expect(history.locator(`[data-date="${loggedDate}"]`)).toBeAttached();
  // Hold an uncached diary request while the chart's monthly data is already cached.
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/activity?*", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("date") !== emptyDate || url.searchParams.has("period")) return route.fallback();
    started(); await held; await route.continue();
  });
  try {
    await page.getByLabel("Activity date", { exact: true }).fill(emptyDate);
    await ready;
    await expect(page.locator(".activity-summary")).toHaveCount(0);
    await expect(page.locator(".activity-entries article")).toHaveCount(0);
    await expect(history.getByRole("button", { name: "M", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(history.getByRole("button", { name: "Steps", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(history.locator(".history-caption")).toHaveText("Total");
    await expect(history.locator(".history-detail")).toContainText("18 Nov 2026");
  } finally { release(); }
  await expect(page.locator(".activity-summary")).toContainText("0");
  await expect(page.locator(".activity-entries article")).toHaveCount(0);
  await history.getByRole("button", { name: "Calories", exact: true }).click();
  await expect(history.locator(".history-value")).toContainText("0");
  const chart = history.getByRole("group", { name: /Daily activity chart/ });
  await chart.focus(); await chart.press("ArrowRight");
  await expect(page.getByLabel("Activity date", { exact: true })).toHaveValue(loggedDate);
  await expect(history.locator(".history-detail")).toContainText("19 Nov 2026");
  await expect(history.locator(".history-value")).toContainText("890.82");
  await expect(page.locator(".activity-summary")).toContainText("890.82");
  await expect(page.locator(".activity-entries")).toContainText("Thursday activity");
  await page.getByLabel("Activity date", { exact: true }).fill(firstDate);
  await expect(history.getByRole("button", { name: "M", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(history.locator(".history-detail")).toContainText("17 Nov 2026");
  await expect(history.locator(".history-value")).toContainText("120");
  await expect(page.locator(".activity-entries")).toContainText("Earlier walk");
});

test("Home shows a compact apple greeting, activity before food, persistent setup and live totals", async ({ page }, info) => {
  await db.execute('DELETE FROM "userProfile" WHERE "userId"=$1', [memberId]);
  await db.execute('DELETE FROM "foodGoalVersion" WHERE "userId"=$1', [memberId]);
  await db.execute('DELETE FROM "foodGoal" WHERE "userId"=$1', [memberId]);
  await db.execute('DELETE FROM "activityGoalVersion" WHERE "userId"=$1', [memberId]);
  await db.execute('DELETE FROM "activityEntry" WHERE "userId"=$1', [memberId]);
  await db.execute('DELETE FROM "foodEntry" WHERE "userId"=$1', [memberId]);
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const setup = page.getByRole("region", { name: "Profile setup", exact: true });
  await expect(setup).toContainText("age, sex, height, weight");
  await expect(page.locator(".home-apple")).toBeVisible();
  await expect(page.locator(".home-welcome")).toHaveCount(0);
  const thought = await page.getByLabel("Today’s thought", { exact: true }).innerText();
  await page.reload(); await expect(page.getByLabel("Today’s thought", { exact: true })).toHaveText(thought);
  await expect(setup).toBeVisible();
  const activity = page.getByRole("region", { name: "Today’s activity", exact: true }), food = page.getByRole("region", { name: "Today’s food intake", exact: true });
  await expect(activity).toHaveAttribute("aria-busy", "false");
  const appleBox = (await page.locator(".home-apple").boundingBox())!, greetingBox = (await page.locator(".home-greeting h1").boundingBox())!;
  expect(appleBox.x).toBeGreaterThan(greetingBox.x + greetingBox.width);
  expect((await activity.boundingBox())!.y).toBeLessThan((await food.boundingBox())!.y);
  await setup.getByRole("button", { name: "Complete your profile", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "Profile", exact: true });
  await profile.getByLabel("Age (years)", { exact: true }).fill("30");
  await profile.getByLabel("Height (cm)", { exact: true }).fill("175");
  await profile.getByLabel("Weight (kg)", { exact: true }).fill("70");
  await profile.getByLabel("Sex", { exact: true }).selectOption("prefer_not_to_say");
  await profile.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(profile.getByRole("status")).toHaveText("Profile saved.");
  await profile.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(setup.locator('li[data-complete="true"]')).toHaveCount(1);
  await setup.getByRole("button", { name: "Set daily food goal", exact: true }).click();
  const foodGoals = page.getByRole("dialog", { name: "Daily food goals", exact: true });
  await foodGoals.getByRole("button", { name: "Save goals", exact: true }).click();
  await expect(foodGoals).not.toBeVisible();
  await expect(setup.locator('li[data-complete="true"]')).toHaveCount(2);
  await setup.getByRole("button", { name: "Set daily activity goal", exact: true }).click();
  const activityGoals = page.getByRole("dialog", { name: "Daily activity goals", exact: true });
  await activityGoals.getByLabel("Logged active calories", { exact: true }).fill("400");
  await activityGoals.getByRole("button", { name: "Save goals", exact: true }).click();
  await expect(activityGoals).not.toBeVisible();
  await expect(setup).toHaveCount(0);
  await nav.getByRole("link", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Log activity", exact: true }).click();
  const workout = page.getByRole("dialog", { name: "Log activity", exact: true });
  await workout.getByLabel("Logging", { exact: true }).selectOption("daily_total");
  await workout.getByLabel("Steps", { exact: true }).fill("10000");
  await workout.getByRole("button", { name: "Save activity", exact: true }).click();
  await expect(workout).not.toBeVisible();
  await nav.getByRole("link", { name: "Home", exact: true }).click();
  await expect(activity.locator(".home-total strong")).toHaveText("254.19");
  await expect(activity).toContainText("10,000");
  await nav.getByRole("link", { name: "Food", exact: true }).click();
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  const meal = page.getByRole("dialog", { name: "Log food", exact: true });
  for (const [label, value] of [["Calories (kcal)", "500"], ["Fat (g)", "20"], ["Protein (g)", "30"], ["Carbs (g)", "50"]]) await meal.getByLabel(label, { exact: true }).fill(value);
  await meal.getByRole("button", { name: "Save food", exact: true }).click();
  await expect(meal).not.toBeVisible();
  await nav.getByRole("link", { name: "Home", exact: true }).click();
  await expect(food.locator(".home-total strong")).toHaveText("500");
  await expect(food).toContainText("30 g");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-home-today.png`, fullPage: true });
  await page.getByRole("button", { name: "Open profile", exact: true }).click();
  await profile.getByLabel("Weight (kg)", { exact: true }).fill("");
  await profile.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(profile.getByRole("status")).toHaveText("Profile saved.");
  await profile.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(setup).toBeVisible(); await expect(setup).toContainText("Add your weight");
});

test("activity goal AI help keeps the date, prepares separate editable goals and updates Home setup", async ({ page }, info) => {
  await db.execute('DELETE FROM "activityGoalVersion" WHERE "userId"=$1', [memberId]);
  let calls = 0;
  await page.route("**/api/food/chat*", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    calls++;
    const next = await sendFoodChat(memberId, await mockedChatInput(route), { settings: chatSettings, fetcher: async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ intent: "activity_goals", reply: "Review the activity targets.", draft: null, goalDraft: null, profileDraft: null, activityDraft: null, activityGoalDraft: { goals: { calories: 400, steps: 8000, minutes: 30 }, effectiveFrom: localDateTime().slice(0,10), assumptions: "Based on the routine you described." } }) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } }) });
    await route.fulfill({ json: next });
  });
  await chatLogin(page);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Set goals", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Daily activity goals", exact: true });
  await form.getByLabel("Logged active calories", { exact: true }).fill("999");
  await form.getByLabel("Apply from", { exact: true }).fill("2026-12-01");
  await form.getByRole("button", { name: "Take help from AI", exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect(nav.getByRole("link", { name: "AI", exact: true })).toHaveAttribute("aria-current", "page");
  const composer = page.getByLabel("Your message", { exact: true });
  await expect(composer).toHaveValue(/daily activity goals.*2026-12-01/); expect(await composer.inputValue()).not.toContain("999"); expect(calls).toBe(0);
  await composer.fill("Help me set daily activity goals for today. I usually walk 7000 steps and want gradual progress.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Review activity goals", exact: true }).click();
  await expect(form.getByLabel("Steps", { exact: true })).toHaveValue("8000");
  const [unsaved] = await db.execute('SELECT targets FROM "activityGoalVersion" WHERE "userId"=$1', [memberId]); expect(unsaved).toHaveLength(0);
  await form.getByLabel("Active minutes", { exact: true }).fill("40");
  await form.getByRole("button", { name: "Save goals", exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect(page.getByText("Your activity goals are saved.", { exact: true })).toBeVisible();
  const [saved] = await db.execute('SELECT targets FROM "activityGoalVersion" WHERE "userId"=$1', [memberId]); expect(saved).toHaveLength(1); expect(saved[0].targets.minutes).toBe(40);
  await nav.getByRole("link", { name: "Home", exact: true }).click();
  const setup = page.getByRole("region", { name: "Profile setup", exact: true });
  // The preceding Home scenario clears weight, so the checklist remains with goals marked done.
  await expect(setup.getByRole("button", { name: "Set daily activity goal", exact: true })).toContainText("Completed");
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-home-setup-goals.png`, fullPage: true });
  await setup.getByRole("button", { name: "Set daily activity goal", exact: true }).click();
  await form.getByRole("button", { name: "Take help from AI", exact: true }).click();
  await expect(composer).toHaveValue(/daily activity goals/); expect(calls).toBe(1);
});
