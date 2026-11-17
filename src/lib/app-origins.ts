import { networkInterfaces } from "node:os";

const vercelHost = process.env.VERCEL ? process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL : undefined;
// Preview shares development secrets, whose local auth URL must stay on localhost.
const previewHost = process.env.VERCEL && process.env.VERCEL_ENV === "preview" ? process.env.VERCEL_URL : undefined;
export const appBaseURL = previewHost ? `https://${previewHost}` : process.env.BETTER_AUTH_URL || (vercelHost ? `https://${vercelHost}` : "http://localhost:3000");

function getDevelopmentOrigins() {
  if ((process.env.NODE_ENV !== "development" && process.env.LAN_PREVIEW !== "true") || process.env.VERCEL) return [];
  const base = new URL(appBaseURL);
  const addresses = [
    "localhost",
    "127.0.0.1",
    ...Object.values(networkInterfaces()).flatMap(entries =>
      (entries ?? []).filter(entry => entry.family === "IPv4" && !entry.internal).map(entry => entry.address),
    ),
  ];
  return [...new Set(addresses.map(address => {
    const url = new URL(base);
    url.hostname = address;
    return url.origin;
  }))];
}

export const developmentOrigins = getDevelopmentOrigins();
export const trustedAppOrigins = [...new Set([new URL(appBaseURL).origin, ...developmentOrigins, ...(process.env.VERCEL && process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : [])])];
