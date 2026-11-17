import { bootstrapAdmin } from "../src/lib/admin";
import { db } from "../src/lib/db";

try {
  const result = await bootstrapAdmin(process.env);
  if (result === "unconfigured") throw new Error("Set BOOT_ADMIN_USER (email) and BOOT_ADMIN_PASS before first-time setup.");
  console.log(result === "created" ? "First administrator created. Sign in at /admin." : "An administrator already exists. No accounts or passwords were changed.");
} catch {
  console.error("Could not bootstrap the administrator. Check the BOOT_ADMIN_USER email, password (12–128 characters), database access, and whether that email already belongs to a member.");
  process.exitCode = 1;
} finally { await db.end(); }
