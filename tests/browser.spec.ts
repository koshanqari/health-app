import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseRow } from "../src/lib/db";
import { db } from "../src/lib/db";
import sharp from "sharp";
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
const chatSettings: FoodAiSettings = { apiKey: "browser-fake-key", scope: aiScope, userDailyLimit: 100, globalDailyLimit: 100, monthlyBudgetMicros: 1000000 };

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
    if (response.ok()) body.quota = aiQuota;
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
  for (const path of ["/login", "/signup", "/admin/login"]) {
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
  await expect(page.getByRole("heading", { name: "Your account is ready." })).toBeVisible();
  await page.reload();
  await expect(page.getByText(signupEmail, { exact: true })).toBeVisible();
  await page.screenshot({ path: `/private/tmp/daywell-${info.project.name}-member.png`, fullPage: true });
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  for (const tab of [
    { name: "Food", heading: "Food" },
    { name: "Activity", heading: "Your activity" },
    { name: "Progress", heading: "Your progress" },
  ]) {
    await navigation.getByRole("link", { name: tab.name, exact: true }).click();
    if (tab.name === "AI") await expect(page.getByRole("region", { name: "Kay", exact: true })).toBeVisible();
      else await expect(page.getByRole("heading", { name: tab.heading, exact: true })).toBeVisible();
    await expect(navigation.getByRole("link", { name: tab.name, exact: true })).toHaveAttribute("aria-current", "page");
    if (tab.name === "Food") await expect(page.getByRole("button", { name: "Log food", exact: true })).toBeVisible();
    else await expect(page.locator(".tab-placeholder:visible").getByText("Coming soon", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.reload();
  await expect(navigation.getByRole("link", { name: "Progress", exact: true })).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your account is ready." })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const accountBox = await page.locator(".account-ready").boundingBox();
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
  await page.goto("/admin/login");
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
  await page.goto("/admin/login");
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
  await page.getByRole("link", { name: "Open profile", exact: true }).click();
  await page.getByRole("dialog", { name: "Profile", exact: true }).getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
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
      { name: "Activity", heading: "Your activity" },
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
    await page.getByRole("link", { name: /Food journal/ }).click();
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
    await expect(page.getByRole("heading", { name: "Your activity", exact: true })).toBeVisible();
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
  await expect(profile.getByLabel("Date of birth", { exact: true })).toHaveValue("");
  await expect(profile.getByLabel("Sex", { exact: true })).toHaveValue("");
  await expect(profile.getByLabel("Height (cm)", { exact: true })).toHaveValue("");
  await expect(profile.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  if (info.project.name === "mobile") {
    const bounds = (await profile.boundingBox())!;
    expect(bounds.x).toBe(0);
    expect(bounds.width).toBe(await page.evaluate(() => innerWidth));
  }
  await profile.getByLabel("Name", { exact: true }).fill("Jordan Bloom");
  await profile.getByLabel("Date of birth", { exact: true }).fill("1992-02-29");
  await profile.getByLabel("Sex", { exact: true }).selectOption("intersex");
  await profile.getByLabel("Height (cm)", { exact: true }).fill("175.5");
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
  await expect(profile.getByLabel("Date of birth", { exact: true })).toHaveValue("1992-02-29");
  await expect(profile.getByLabel("Sex", { exact: true })).toHaveValue("intersex");
  await expect(profile.getByLabel("Height (cm)", { exact: true })).toHaveValue("175.5");
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
  await page.goto("/admin/login");
  await page.getByLabel("Email address", { exact: true }).fill(adminEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "Open profile", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "Profile", exact: true });
  await expect(profile.getByLabel("Name", { exact: true })).toHaveValue("Browser Administrator");
  await expect(profile.getByLabel("Email", { exact: true })).toHaveValue(adminEmail);
  await profile.getByRole("button", { name: "Back to app", exact: true }).click();
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
  await dialog.getByLabel("Apply from", { exact: true }).fill("2021-01-01");
  await dialog.getByRole("button", { name: "Take help from AI" }).click();
  await expect(dialog).toHaveCount(0);
  const input = page.getByLabel("Your message", { exact: true });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(/Help me set daily calorie/);
  await expect(input).toHaveValue(/2021-01-01/);
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
