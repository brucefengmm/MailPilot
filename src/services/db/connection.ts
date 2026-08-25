import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;

/** Serializes all SQLite operations — required because sqlx pool acquires per call. */
let dbOpQueue: Promise<unknown> = Promise.resolve();

export function runSerializedDb<T>(fn: () => Promise<T>): Promise<T> {
  const run = dbOpQueue.then(fn, fn);
  dbOpQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function wrapDb(database: Database): Database {
  const originalExecute = database.execute.bind(database);
  const originalSelect = database.select.bind(database);

  database.execute = (sql: string, bindValues?: unknown[]) =>
    runSerializedDb(() => originalExecute(sql, bindValues ?? []));

  database.select = <T>(sql: string, bindValues?: unknown[]) =>
    runSerializedDb(() => originalSelect<T>(sql, bindValues ?? []));

  return database;
}

export async function getDb(): Promise<Database> {
  if (!db) {
    const loaded = await Database.load("sqlite:mailpilot.db");
    db = wrapDb(loaded);
    // WAL allows readers during heavy sync writes; busy_timeout avoids immediate lock errors.
    await db.execute("PRAGMA journal_mode = WAL", []);
    await db.execute("PRAGMA busy_timeout = 30000", []);
  }
  return db;
}

/**
 * Build a dynamic SQL UPDATE statement from a set of field updates.
 * Returns null if no fields to update.
 */
export function buildDynamicUpdate(
  table: string,
  idColumn: string,
  id: unknown,
  fields: [string, unknown][],
): { sql: string; params: unknown[] } | null {
  if (fields.length === 0) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const [column, value] of fields) {
    sets.push(`${column} = $${idx++}`);
    params.push(value);
  }

  params.push(id);
  return {
    sql: `UPDATE ${table} SET ${sets.join(", ")} WHERE ${idColumn} = $${idx}`,
    params,
  };
}

/**
 * Simple async mutex to prevent concurrent SQLite transactions.
 * SQLite only supports one writer at a time; overlapping BEGIN/COMMIT/ROLLBACK
 * on the same connection causes "cannot start a transaction within a transaction"
 * or "database is locked" errors.
 */
let txQueue: Promise<void> = Promise.resolve();

export async function withTransaction(fn: (db: Database) => Promise<void>): Promise<void> {
  // Queue this transaction behind any currently-running one.
  // This serialises all transactions without blocking non-transactional reads.
  const prev = txQueue;
  let resolve!: () => void;
  txQueue = new Promise<void>((r) => {
    resolve = r;
  });

  try {
    await prev; // wait for previous transaction to finish
  } catch {
    // previous transaction errored — that's fine, we can still proceed
  }

  const database = await getDb();
  try {
    // IMMEDIATE acquires the write lock up front so we don't stall mid-batch.
    await database.execute("BEGIN IMMEDIATE", []);
    try {
      await fn(database);
      await database.execute("COMMIT", []);
    } catch (err) {
      // SQLite may auto-rollback on certain errors — guard against
      // "cannot rollback - no transaction is active"
      try {
        await database.execute("ROLLBACK", []);
      } catch {
        // ROLLBACK failed (already rolled back) — safe to ignore
      }
      throw err;
    }
  } finally {
    resolve(); // always unblock the next queued transaction
  }
}

/**
 * Execute a SELECT query and return the first result or null.
 */
export async function selectFirstBy<T>(
  query: string,
  params: unknown[] = [],
): Promise<T | null> {
  const conn = await getDb();
  const rows = await conn.select<T[]>(query, params);
  return rows[0] ?? null;
}

/**
 * Execute a COUNT(*) query and return whether any rows exist.
 */
export async function existsBy(
  query: string,
  params: unknown[] = [],
): Promise<boolean> {
  const conn = await getDb();
  const rows = await conn.select<{ count: number }[]>(query, params);
  return (rows[0]?.count ?? 0) > 0;
}

/**
 * Convert a boolean to SQLite integer (0 or 1).
 */
export function boolToInt(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}
