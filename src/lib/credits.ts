import { randomUUID } from "node:crypto";
import { db, type DatabaseConnection, type DatabaseRow } from "./db";

export const CREDIT_RESERVATION_USD_MICROS = 10_000;
const priceVersion = "gemini-3.1-flash-lite-v1";
export type CreditStatus = { balance: number; available: number; held: number; multiplier: number; estimatedReplies: number; estimatedReplyCost: number; maximumReplyCharge: number };
export type CreditTransaction = { id: string; kind: string; amount: number; balanceAfter: number; reason: string; createdAt: string; multiplier: number | null; amountPaid: number | null; actorName: string | null };
export type CreditDetails = CreditStatus & { transactions: CreditTransaction[] };
export type PublicCreditStatus = Pick<CreditStatus, "balance" | "available" | "estimatedReplies"> & { canSend: boolean };
export type PublicCreditDetails = PublicCreditStatus & { transactions: Pick<CreditTransaction, "id" | "kind" | "amount" | "balanceAfter" | "reason" | "createdAt">[] };
export function publicCreditStatus(data: CreditStatus): PublicCreditStatus {
  return { balance: data.balance, available: data.available, estimatedReplies: data.estimatedReplies, canSend: data.available >= data.maximumReplyCharge };
}
export function publicCreditDetails(data: CreditDetails): PublicCreditDetails {
  return { ...publicCreditStatus(data), transactions: data.transactions.filter(item => item.kind !== "pricing").map(item => ({
    id: item.id, kind: item.kind, amount: item.amount, balanceAfter: item.balanceAfter, createdAt: item.createdAt,
    reason: item.kind === "welcome" ? "Welcome credits" : item.kind === "topup" ? "Credits added" : item.kind === "refund" ? "Credits returned" : item.amount === 0 ? "AI reply · No charge" : "AI reply",
  })) };
}
export class CreditError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function decimal(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || Math.abs(value * 100 - Math.round(value * 100)) > .000001) throw new CreditError(400, "CREDIT_INPUT", `Use ${label} between ${min} and ${max}, with at most two decimal places.`);
  return Math.round(value * 100);
}
export function creditSettings() {
  return {
    welcomeCents: decimal(Number(process.env.AI_WELCOME_CREDITS ?? 20), 0, 1000, "welcome credits"),
    fxCents: decimal(Number(process.env.AI_CREDIT_INR_PER_USD ?? 100), 1, 1000, "INR per USD"),
  };
}
// Integer arithmetic: USD micros × INR cents/USD × multiplier hundredths -> credit cents.
export function creditCharge(costMicros: number, fxCents: number, multiplierHundred: number) {
  return Number((BigInt(costMicros) * BigInt(fxCents) * BigInt(multiplierHundred) + 99_999_999n) / 100_000_000n);
}
export async function migrateCredits(connection: DatabaseConnection) {
  const { welcomeCents } = creditSettings();
  await connection.execute(`CREATE TABLE IF NOT EXISTS "creditWallet" (
    "userId" TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    "balanceCents" BIGINT NOT NULL DEFAULT 0 CHECK ("balanceCents" BETWEEN 0 AND 1000000000000),
    "heldCents" BIGINT NOT NULL DEFAULT 0 CHECK ("heldCents" >= 0 AND "heldCents" <= "balanceCents"),
    "multiplierHundred" INTEGER NOT NULL DEFAULT 200 CHECK ("multiplierHundred" BETWEEN 10 AND 1000)
  )`);
  for (const sql of [
    'ALTER TABLE "foodAiUsage" ADD COLUMN IF NOT EXISTS "creditReservedCents" INTEGER NOT NULL DEFAULT 0 CHECK ("creditReservedCents" >= 0)',
    'ALTER TABLE "foodAiUsage" ADD COLUMN IF NOT EXISTS "creditHoldActive" BOOLEAN NOT NULL DEFAULT FALSE',
    'ALTER TABLE "foodAiUsage" ADD COLUMN IF NOT EXISTS "creditMultiplierHundred" INTEGER',
    'ALTER TABLE "foodAiUsage" ADD COLUMN IF NOT EXISTS "creditFxCents" INTEGER',
    'ALTER TABLE "foodAiUsage" ADD COLUMN IF NOT EXISTS "creditPriceVersion" TEXT',
  ]) await connection.execute(sql);
  await connection.execute(`CREATE TABLE IF NOT EXISTS "creditLedger" (
    id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('welcome','topup','refund','usage','pricing')),
    "amountCents" BIGINT NOT NULL, "balanceAfterCents" BIGINT NOT NULL CHECK ("balanceAfterCents" >= 0),
    reason VARCHAR(250) NOT NULL, "actorId" TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    "usageId" TEXT UNIQUE REFERENCES "foodAiUsage"(id) ON DELETE SET NULL,
    "amountPaidCents" BIGINT CHECK ("amountPaidCents" >= 0), "multiplierHundred" INTEGER,
    "fxCents" INTEGER, "providerCostMicros" BIGINT, fingerprint TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
  )`);
  await connection.execute('ALTER TABLE "creditLedger" ADD COLUMN IF NOT EXISTS "refundUsageId" TEXT UNIQUE REFERENCES "foodAiUsage"(id) ON DELETE SET NULL');
  await connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS credit_welcome_once ON "creditLedger" ("userId") WHERE kind = \'welcome\'');
  await connection.execute('CREATE INDEX IF NOT EXISTS credit_history ON "creditLedger" ("userId", "createdAt" DESC, id DESC)');
  await connection.execute('CREATE INDEX IF NOT EXISTS credit_pending_holds ON "foodAiUsage" ("userId", "createdAt") WHERE "creditHoldActive"');
  await connection.execute(`CREATE OR REPLACE FUNCTION daywell_welcome_credits() RETURNS TRIGGER AS $$
    BEGIN
      INSERT INTO "creditWallet" ("userId", "balanceCents") VALUES (NEW.id, ${welcomeCents}) ON CONFLICT DO NOTHING;
      IF FOUND THEN
        INSERT INTO "creditLedger" (id, "userId", kind, "amountCents", "balanceAfterCents", reason)
        VALUES (gen_random_uuid()::text, NEW.id, 'welcome', ${welcomeCents}, ${welcomeCents}, 'Welcome credits');
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);
  await connection.execute('DROP TRIGGER IF EXISTS daywell_welcome_credits ON "user"');
  await connection.execute('CREATE TRIGGER daywell_welcome_credits AFTER INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION daywell_welcome_credits()');
  await connection.execute(`WITH fresh AS (
    INSERT INTO "creditWallet" ("userId", "balanceCents") SELECT id, ${welcomeCents} FROM "user" ON CONFLICT DO NOTHING RETURNING "userId"
  ) INSERT INTO "creditLedger" (id, "userId", kind, "amountCents", "balanceAfterCents", reason)
    SELECT gen_random_uuid()::text, "userId", 'welcome', ${welcomeCents}, ${welcomeCents}, 'Welcome credits' FROM fresh`);
}
async function lockWallet(connection: DatabaseConnection, userId: string) {
  const [rows] = await connection.execute<DatabaseRow[]>('SELECT * FROM "creditWallet" WHERE "userId" = $1 FOR UPDATE', [userId]);
  if (!rows.length) throw new CreditError(404, "CREDIT_WALLET", "This credit account was not found.");
  const wallet = rows[0];
  const [expired] = await connection.execute<DatabaseRow[]>(`SELECT id, "creditReservedCents" FROM "foodAiUsage"
    WHERE "userId" = $1 AND "creditHoldActive" AND "createdAt" < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '5 minutes' FOR UPDATE`, [userId]);
  const released = expired.reduce((total, row) => total + Number(row.creditReservedCents), 0);
  if (released) {
    await connection.execute('UPDATE "foodAiUsage" SET "creditHoldActive" = FALSE WHERE id = ANY($1::text[])', [expired.map(row => row.id)]);
    await connection.execute('UPDATE "creditWallet" SET "heldCents" = "heldCents" - $1 WHERE "userId" = $2', [released, userId]);
    wallet.heldCents = Number(wallet.heldCents) - released;
  }
  return { balanceCents: Number(wallet.balanceCents), heldCents: Number(wallet.heldCents), multiplierHundred: Number(wallet.multiplierHundred) };
}
export async function reserveCredits(connection: DatabaseConnection, userId: string) {
  const wallet = await lockWallet(connection, userId), { fxCents } = creditSettings();
  const cents = creditCharge(CREDIT_RESERVATION_USD_MICROS, fxCents, wallet.multiplierHundred);
  if (wallet.balanceCents - wallet.heldCents < cents) throw new CreditError(402, "AI_CREDITS", "You don’t have enough credits for another reply. Add credits to continue with Kay.");
  await connection.execute('UPDATE "creditWallet" SET "heldCents" = "heldCents" + $1 WHERE "userId" = $2', [cents, userId]);
  return { cents, fxCents, multiplierHundred: wallet.multiplierHundred, priceVersion };
}
export async function settleCredits(connection: DatabaseConnection, userId: string | null, usageId: string, costMicros: number, chargeable: boolean, reason: string) {
  if (!userId) return;
  const wallet = await lockWallet(connection, userId);
  const [rows] = await connection.execute<DatabaseRow[]>('SELECT * FROM "foodAiUsage" WHERE id = $1 AND "userId" = $2 FOR UPDATE', [usageId, userId]);
  const usage = rows[0];
  if (usage?.status !== "pending" || !usage.creditMultiplierHundred) return; // Pre-wallet requests are never charged retroactively.
  const reserved = Number(usage.creditReservedCents);
  const charged = chargeable && usage.creditHoldActive ? Math.min(reserved, creditCharge(costMicros, usage.creditFxCents, usage.creditMultiplierHundred)) : 0;
  const [prior] = await connection.execute<DatabaseRow[]>('SELECT id FROM "creditLedger" WHERE "usageId" = $1', [usageId]);
  if (prior.length) return;
  await connection.execute('UPDATE "creditWallet" SET "heldCents" = "heldCents" - $1, "balanceCents" = "balanceCents" - $2 WHERE "userId" = $3', [usage.creditHoldActive ? reserved : 0, charged, userId]);
  await connection.execute('UPDATE "foodAiUsage" SET "creditHoldActive" = FALSE WHERE id = $1', [usageId]);
  await connection.execute(`INSERT INTO "creditLedger" (id, "userId", kind, "amountCents", "balanceAfterCents", reason, "usageId", "multiplierHundred", "fxCents", "providerCostMicros")
    VALUES ($1, $2, 'usage', $3, $4, $5, $6, $7, $8, $9)`, [randomUUID(), userId, -charged, wallet.balanceCents - charged, reason, usageId, usage.creditMultiplierHundred, usage.creditFxCents, costMicros]);
}
export async function getCreditDetails(userId: string, includeHistory = true): Promise<CreditDetails> {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const wallet = await lockWallet(connection, userId), { fxCents } = creditSettings();
    const [average] = await connection.execute<DatabaseRow[]>(`SELECT AVG("costMicros") AS average FROM (
      SELECT "costMicros" FROM "foodAiUsage" WHERE "userId" = $1 AND status = 'succeeded' AND "promptTokens" IS NOT NULL AND "costMicros" > 0 ORDER BY "createdAt" DESC LIMIT 20
    ) recent`, [userId]);
    const typical = creditCharge(Math.ceil(Number(average[0].average ?? 1500)), fxCents, wallet.multiplierHundred);
    const available = wallet.balanceCents - wallet.heldCents, maximum = creditCharge(CREDIT_RESERVATION_USD_MICROS, fxCents, wallet.multiplierHundred);
    let transactions: CreditTransaction[] = [];
    if (includeHistory) {
      const [rows] = await connection.execute<DatabaseRow[]>(`SELECT id, kind, "amountCents", "balanceAfterCents", reason, "multiplierHundred", "amountPaidCents",
        to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt", (SELECT a.name FROM "user" a WHERE a.id = "creditLedger"."actorId") AS "actorName" FROM "creditLedger" WHERE "userId" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 30`, [userId]);
      transactions = rows.map(row => ({ id: row.id, kind: row.kind, amount: Number(row.amountCents) / 100, balanceAfter: Number(row.balanceAfterCents) / 100, reason: row.reason, createdAt: row.createdAt, multiplier: row.multiplierHundred === null ? null : row.multiplierHundred / 100, amountPaid: row.amountPaidCents === null ? null : Number(row.amountPaidCents) / 100, actorName: row.actorName ?? null }));
    }
    await connection.commit();
    return { balance: wallet.balanceCents / 100, available: available / 100, held: wallet.heldCents / 100, multiplier: wallet.multiplierHundred / 100, estimatedReplies: available < maximum ? 0 : Math.max(0, Math.floor((available - maximum) / Math.max(typical, 1)) + 1), estimatedReplyCost: typical / 100, maximumReplyCharge: maximum / 100, transactions };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
export async function administerCredits(actorId: string, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CreditError(400, "CREDIT_INPUT", "Check the credit details.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["requestId", "userId", "action", "amount", "amountPaid", "reason", "multiplier"].includes(key)) || typeof input.requestId !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.requestId) || typeof input.userId !== "string" || !input.userId || input.userId.length > 128 || (typeof input.action !== "string" || !["topup", "refund", "pricing"].includes(input.action))) throw new CreditError(400, "CREDIT_INPUT", "Check the credit details.");
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 250 || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new CreditError(400, "CREDIT_INPUT", "Add a reason or payment reference (up to 250 characters).");
  const amount = input.action === "pricing" ? 0 : decimal(input.amount, .01, 100000, "credits");
  const rate = input.action === "pricing" ? decimal(input.multiplier, .1, 10, "multiplier") : null;
  const paid = input.action !== "topup" || input.amountPaid === undefined || input.amountPaid === null || input.amountPaid === "" ? null : decimal(input.amountPaid, 0, 100000, "money received");
  const fingerprint = JSON.stringify([input.userId, input.action, amount, rate, paid, input.reason.trim()]);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [actors] = await connection.execute<DatabaseRow[]>('SELECT role FROM "user" WHERE id = $1 FOR SHARE', [actorId]);
    if (actors[0]?.role !== "admin") throw new CreditError(403, "CREDIT_ADMIN", "Administrator access required.");
    const wallet = await lockWallet(connection, input.userId);
    const [prior] = await connection.execute<DatabaseRow[]>('SELECT "actorId", fingerprint FROM "creditLedger" WHERE id = $1', [input.requestId]);
    if (prior.length) {
      if (prior[0].actorId !== actorId || prior[0].fingerprint !== fingerprint) throw new CreditError(409, "CREDIT_REUSED", "Use a new confirmation for changed credit details.");
      await connection.commit(); return;
    }
    if (wallet.balanceCents + amount > 1_000_000_000_000) throw new CreditError(400, "CREDIT_INPUT", "This balance would be too large.");
    if (rate !== null) await connection.execute('UPDATE "creditWallet" SET "multiplierHundred" = $1 WHERE "userId" = $2', [rate, input.userId]);
    else await connection.execute('UPDATE "creditWallet" SET "balanceCents" = "balanceCents" + $1 WHERE "userId" = $2', [amount, input.userId]);
    await connection.execute(`INSERT INTO "creditLedger" (id, "userId", kind, "amountCents", "balanceAfterCents", reason, "actorId", "amountPaidCents", "multiplierHundred", fingerprint)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [input.requestId, input.userId, input.action, amount, wallet.balanceCents + amount, input.reason.trim(), actorId, paid, rate ?? wallet.multiplierHundred, fingerprint]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

// Compensate a metered provider reply that could not be added to its conversation.
export async function refundUndeliveredReply(userId: string, usageId: string) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const wallet = await lockWallet(connection, userId);
    const [charges] = await connection.execute<DatabaseRow[]>('SELECT "amountCents", "multiplierHundred" FROM "creditLedger" WHERE "usageId" = $1 AND "userId" = $2', [usageId, userId]);
    const [refunds] = await connection.execute<DatabaseRow[]>('SELECT id FROM "creditLedger" WHERE "refundUsageId" = $1', [usageId]);
    const amount = -Number(charges[0]?.amountCents ?? 0);
    if (amount > 0 && !refunds.length) {
      await connection.execute('UPDATE "creditWallet" SET "balanceCents" = "balanceCents" + $1 WHERE "userId" = $2', [amount, userId]);
      await connection.execute(`INSERT INTO "creditLedger" (id, "userId", kind, "amountCents", "balanceAfterCents", reason, "refundUsageId", "multiplierHundred")
        VALUES ($1, $2, 'refund', $3, $4, 'Reply interrupted · Credits returned', $5, $6)`, [randomUUID(), userId, amount, wallet.balanceCents + amount, usageId, charges[0].multiplierHundred]);
    }
    await connection.execute('UPDATE "foodAiUsage" SET "resultJson" = NULL, "cacheExpiresAt" = NULL WHERE id = $1 AND "userId" = $2', [usageId, userId]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
