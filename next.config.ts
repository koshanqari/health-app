import type { NextConfig } from "next";
import { developmentOrigins } from "./src/lib/app-origins";

const config: NextConfig = {
  agentRules: false,
  env: { NEXT_PUBLIC_APP_RELEASE: process.env.APP_RELEASE_ID || process.env.NEXT_DEPLOYMENT_ID || process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL || process.env.VERCEL_GIT_COMMIT_SHA || "local" },
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  poweredByHeader: false,
  allowedDevOrigins: developmentOrigins.map(origin => new URL(origin).hostname),
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};

export default config;
