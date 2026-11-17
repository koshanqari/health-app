import { createPool } from "mysql2/promise";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { db, pool } from "../src/lib/db";

// Run against an empty, migrated Postgres target. Never updates or deletes source records.
const local = parseEnv(readFileSync(".env.local", "utf8"));
const sourceURL = process.env.MYSQL_SOURCE_DATABASE_URL || local.MYSQL_SOURCE_DATABASE_URL || (local.DATABASE_URL?.startsWith("mysql:") ? local.DATABASE_URL : undefined);
const tables = ["user", "account", "foodAiBudget", "foodAiUsage", "foodEntry"] as const;
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let source: ReturnType<typeof createPool> | undefined;
try {
  if (!sourceURL) throw new Error("Set MYSQL_SOURCE_DATABASE_URL to the original local database before importing.");
  const sourceAddress = new URL(sourceURL);
  if (sourceAddress.protocol !== "mysql:" || !["localhost", "127.0.0.1"].includes(sourceAddress.hostname)) throw new Error("This importer reads only the original local MySQL database.");
  source = createPool({ host: sourceAddress.hostname, port: Number(sourceAddress.port || 3306), user: decodeURIComponent(sourceAddress.username), password: decodeURIComponent(sourceAddress.password), database: decodeURIComponent(sourceAddress.pathname.slice(1)), timezone: "Z", connectionLimit: 1 });
  const connection = await source.getConnection();
  const snapshot: Record<string, Record<string, unknown>[]> = {};
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    for (const table of tables) {
      const [rows] = await connection.query(`SELECT * FROM \`${table}\``);
      snapshot[table] = rows as Record<string, unknown>[];
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  // Private recovery snapshot, explicitly excluded from Git and Vercel uploads.
  mkdirSync(".backups", { recursive: true, mode: 0o700 });
  const backup = `.backups/mysql-${new Date().toISOString().replaceAll(":", "-")}.json`;
  writeFileSync(backup, JSON.stringify(snapshot), { mode: 0o600 });
  const snapshotHash = hash(snapshot);
  const target = await pool.connect();
  try {
    await target.query("BEGIN");
    await target.query("SELECT pg_advisory_xact_lock(1835462102)");
    await target.query('CREATE TABLE IF NOT EXISTS "_daywellImport" (id TEXT PRIMARY KEY, "snapshotHash" TEXT NOT NULL, "importedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const marker = await target.query('SELECT "snapshotHash" FROM "_daywellImport" WHERE id = $1', ['mysql-v1']);
    if (marker.rows.length) {
      if (marker.rows[0].snapshotHash !== snapshotHash) throw new Error("This target already has an imported snapshot. Refusing to overwrite or merge a different source snapshot.");
      await target.query("COMMIT"); console.log("This exact MySQL snapshot was already imported; no target data changed.");
    } else {
      const verified: Record<string, number> = {};
      for (const table of tables) {
        const present = await target.query(`SELECT COUNT(*)::integer AS count FROM ${quote(table)}`);
        if (present.rows[0].count !== 0) throw new Error(`Target ${table} is not empty. Refusing to overwrite existing data.`);
      }
      for (const table of tables) {
        const columnsResult = await target.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [table]);
        const types = new Map<string, string>(columnsResult.rows.map(row => [row.column_name, row.data_type]));
        const columns = snapshot[table].length ? Object.keys(snapshot[table][0]) : [];
        for (const column of columns) if (!types.has(column)) throw new Error(`Source column ${table}.${column} has no target mapping.`);
        const records = snapshot[table].map(row => Object.fromEntries(columns.map(column => {
          let value = row[column];
          if (types.get(column) === "boolean" && value !== null) value = Boolean(value);
          if (table === "foodEntry" && column === "chatMessageId") value = null;
          if (table === "foodAiUsage" && ["resultJson", "cacheExpiresAt"].includes(column)) value = null;
          if (table === "foodAiUsage" && column === "status" && value === "pending") value = "failed";
          return [column, value];
        })));
        for (let offset = 0; offset < records.length; offset += 100) {
          const batch = records.slice(offset, offset + 100), values: unknown[] = [];
          const tuples = batch.map(row => '(' + columns.map(column => { const value = row[column]; values.push(value instanceof Date ? value.toISOString() : value); return '$' + values.length; }).join(',') + ')');
          await target.query(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES ${tuples.join(',')}`, values);
        }
        const actual = await target.query(`SELECT * FROM ${quote(table)}`);
        const canonical = (rows: Record<string, unknown>[]) => rows.map(row => JSON.stringify(columns.map(column => {
          const value = row[column];
          if (value === null || value === undefined) return null;
          if (value instanceof Date) return value.toISOString();
          return String(value);
        }))).sort();
        if (actual.rows.length !== records.length || hash(canonical(actual.rows)) !== hash(canonical(records))) throw new Error(`Verification failed for ${table}; rolling back the import.`);
        verified[table] = records.length;
      }
      await target.query('INSERT INTO "_daywellImport" (id, "snapshotHash") VALUES ($1, $2)', ['mysql-v1', snapshotHash]);
      await target.query("COMMIT");
      console.log(JSON.stringify({ importedAndVerified: verified, backupFile: backup, omitted: ["sessions", "verification tokens", "rate limits", "temporary conversations", "cached AI responses"] }));
    }
  } catch (error) { await target.query("ROLLBACK"); throw error; }
  finally { target.release(); }
} catch (error) {
  const message = error instanceof Error ? error.message : "Import failed.";
  // Known local validation messages contain no row data or connection secrets.
  if (/^(Set MYSQL_SOURCE|This importer|This target|Target |Source column|Verification failed)/.test(message)) console.error(message);
  else console.error("MySQL import failed. Both source data and any previously committed target data are unchanged.", (error as { code?: string })?.code ?? "");
  process.exitCode = 1;
} finally { await source?.end(); await db.end(); }
