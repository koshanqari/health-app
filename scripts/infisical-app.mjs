import { spawn } from "node:child_process";

// Check injected values before Next.js can fill gaps from the old .env.local.
const required = ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "GEMINI_API_KEY", "AI_MONTHLY_BUDGET_USD", "AI_DAILY_LIMIT", "AI_GLOBAL_DAILY_LIMIT"];
const missing = required.filter(key => !process.env[key]?.trim());
if (missing.length) {
  console.error(`Missing Infisical development secrets: ${missing.join(", ")}. Nothing was started.`);
  process.exit(1);
}
const commands = {
  dev: ["node_modules/next/dist/bin/next", "dev", "--hostname", "0.0.0.0"],
  migrate: ["--import", "tsx", "scripts/migrate.ts"],
  admin: ["--import", "tsx", "scripts/create-admin.ts"],
  "preview:build": ["node_modules/next/dist/bin/next", "build"],
  preview: ["node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"],
};
const args = commands[process.argv[2]];
if (!args) throw new Error("Choose dev, migrate, admin, preview:build, or preview.");
if (process.argv[2].startsWith("preview")) process.env.NEXT_BUILD_DIR = ".next-preview";
if (process.argv[2] === "preview") process.env.LAN_PREVIEW = "true";
const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
child.on("error", () => { console.error("Could not start the app command."); process.exitCode = 1; });
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
