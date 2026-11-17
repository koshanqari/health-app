import { AdminError, bootstrapAdmin } from "../src/lib/admin";
import { db } from "../src/lib/db";

try {
  const result = await bootstrapAdmin(process.env);
  if (result === "unconfigured") throw new Error("Set BOOT_ADMIN_USER to your existing account’s email before setup.");
  console.log(result === "promoted" ? "Existing account granted administrator access. Sign in at /admin with its usual password." : "The configured account is already an administrator. No accounts or passwords were changed.");
} catch (error) {
  console.error(error instanceof AdminError ? error.message : "Could not bootstrap the administrator. Check BOOT_ADMIN_USER and database access.");
  process.exitCode = 1;
} finally { await db.end(); }
