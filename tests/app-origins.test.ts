import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function origins(settings: Record<string, string>) {
  const env = { ...process.env };
  for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL", "APP_TRUSTED_ORIGINS", "BETTER_AUTH_URL", "LAN_PREVIEW"]) delete env[key];
  Object.assign(env, { NODE_ENV: "production" }, settings);
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'import { appBaseURL, trustedAppOrigins } from "./src/lib/app-origins.ts"; console.log(JSON.stringify({appBaseURL,trustedAppOrigins}));'], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(output) as { appBaseURL: string; trustedAppOrigins: string[] };
}

test("preview trusts its explicit custom alias and generated host without trusting other sites", () => {
  const result = origins({ VERCEL: "1", VERCEL_ENV: "preview", VERCEL_URL: "deployment.vercel.app", BETTER_AUTH_URL: "http://localhost:3000", APP_TRUSTED_ORIGINS: " https://dev-daywell-health.vercel.app/,https://dev-daywell-health.vercel.app " });
  assert.equal(result.appBaseURL, "https://deployment.vercel.app");
  assert.deepEqual(result.trustedAppOrigins, ["https://deployment.vercel.app", "https://dev-daywell-health.vercel.app"]);
  for (const bad of ["https://other.vercel.app", "https://dev-daywell-health.vercel.app.attacker.example", "http://localhost:3000"]) assert.ok(!result.trustedAppOrigins.includes(bad));
});

test("local and production keep their own canonical origins without development aliases", () => {
  assert.equal(origins({ BETTER_AUTH_URL: "http://localhost:3000" }).appBaseURL, "http://localhost:3000");
  const production = origins({ VERCEL: "1", VERCEL_ENV: "production", VERCEL_URL: "deployment.vercel.app", BETTER_AUTH_URL: "https://daywell-health.vercel.app" });
  assert.deepEqual(production.trustedAppOrigins, ["https://daywell-health.vercel.app", "https://deployment.vercel.app"]);
});

test("trusted origin configuration rejects malformed, wildcard and non-origin URLs", () => {
  for (const bad of ["not a URL", "https://*.vercel.app", "https://example.com/login", "https://user:password@example.com", "https://example.com?x=1", "https://example.com#fragment", "file:///tmp/example"]) assert.throws(() => origins({ APP_TRUSTED_ORIGINS: bad }));
});
