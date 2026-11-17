import { attachDatabasePool } from "@vercel/functions";
import { Pool, types, type PoolClient, type QueryResult } from "pg";

// Local reporting timestamps are stored without a timezone but decoded consistently as UTC.
types.setTypeParser(1114, value => new Date(value.replace(" ", "T") + "Z"));
export type DatabaseRow = Record<string, any>;
export type DatabaseChange = { affectedRows: number };
type Executor = { query: (sql: string, values?: any[]) => Promise<QueryResult> };
function execute<T = DatabaseRow[]>(executor: Executor, sql: string, values: unknown[] = []): Promise<[T]> {
  return executor.query(sql, values.map(value => value instanceof Date ? value.toISOString() : value))
    .then(result => [(result.command === "SELECT" || result.rows.length ? result.rows : { affectedRows: result.rowCount ?? 0 }) as T]);
}
export type DatabaseConnection = {
  execute: <T = DatabaseRow[]>(sql: string, values?: unknown[]) => Promise<[T]>;
  beginTransaction: () => Promise<void>; commit: () => Promise<void>; rollback: () => Promise<void>; release: () => void;
};
function connection(client: PoolClient): DatabaseConnection {
  return {
    execute: (sql, values) => execute(client, sql, values),
    beginTransaction: async () => { await client.query("BEGIN"); },
    commit: async () => { await client.query("COMMIT"); },
    rollback: async () => { await client.query("ROLLBACK"); },
    release: () => client.release(),
  };
}
function createDatabase() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("Set DATABASE_URL before starting the app.");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("DATABASE_URL must use Postgres (Neon).");
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (!local) for (const key of ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
  const created = new Pool({ connectionString: url.toString(), ...(local ? {} : { ssl: { rejectUnauthorized: true }, enableChannelBinding: true }), max: 3, idleTimeoutMillis: 5000, connectionTimeoutMillis: 15000, allowExitOnIdle: true });
  if (process.env.VERCEL) attachDatabasePool(created);
  return created;
}
const globalDatabase = globalThis as unknown as { healthPostgres?: Pool };
export const pool = globalDatabase.healthPostgres ?? createDatabase();
globalDatabase.healthPostgres = pool;
export const db = {
  execute: <T = DatabaseRow[]>(sql: string, values?: unknown[]) => execute<T>(pool, sql, values),
  getConnection: async () => connection(await pool.connect()),
  end: () => pool.end(),
};
