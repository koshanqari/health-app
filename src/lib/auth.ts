import { betterAuth } from "better-auth";
import { pool } from "./db";
import { appBaseURL, trustedAppOrigins } from "./app-origins";

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret || secret.length < 32) {
  throw new Error("Set a random BETTER_AUTH_SECRET of at least 32 characters.");
}

// Server and administrative scripts only. The browser imports auth-client.ts.
export const auth = betterAuth({
  appName: "Daywell",
  baseURL: appBaseURL,
  secret,
  trustedOrigins: trustedAppOrigins,
  database: pool,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
  },
  user: {
    additionalFields: {
      role: {
        type: ["user", "admin"],
        required: false,
        defaultValue: "user",
        input: false,
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: false },
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 8 },
      "/sign-up/email": { window: 60, max: 5 },
    },
  },
  advanced: {
    ipAddress: {
      ipAddressHeaders: process.env.VERCEL
        ? ["x-vercel-forwarded-for"]
        : ["x-forwarded-for"],
    },
  },
});
