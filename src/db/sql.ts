// The Store's statements go through Sql, written in the subset of SQL that SQLite and Postgres share: `?` placeholders,
// ON CONFLICT upserts, explicit INSERT column lists, and an ORDER BY with a tie-breaker on every query that returns
// more than one row. The store's queue (src/store-queue.ts) runs one Store call at a time over it.
import { AsyncLocalStorage } from "node:async_hooks";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type SqlValue = string | number | null;

export interface Sql {
  readonly dialect: "sqlite" | "postgres";
  all<T>(text: string, params?: readonly SqlValue[]): Promise<T[]>;
  /** The first row, or undefined for none. */
  get<T>(text: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  /** `changes`: how many rows the statement inserted, updated or deleted. */
  run(text: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  /**
   * Run `fn` in a transaction, committed once it resolves and rolled back if it throws. This Sql's calls from `fn`
   * run in it, and a transaction `fn` starts is a savepoint, rolled back alone if it throws. Calls from outside `fn`
   * wait until it ends.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** A transaction, or a savepoint in one, while `fn` runs. */
interface Frame { depth: number; open: boolean }

// One per handle, so stores sharing a handle (tests do) wait for each other's transactions.
const sqliteExecutors = new WeakMap<Database, Sql>();

/** Sql over the plugin's SQLite database. */
export function sqliteSql(db: Database): Sql {
  let sql = sqliteExecutors.get(db);
  if (!sql) sqliteExecutors.set(db, sql = createSqliteSql(db));
  return sql;
}

function createSqliteSql(db: Database): Sql {
  const frames = new AsyncLocalStorage<Frame>();
  // The open transaction's end, which calls from outside it wait for. Never rejects.
  let running: Promise<void> | null = null;
  const outside = () => !frames.getStore()?.open;

  async function savepoint<T>(depth: number, fn: () => Promise<T>): Promise<T> {
    const name = `sql_savepoint_${depth}`;
    db.exec(`SAVEPOINT ${name}`);
    const frame: Frame = { depth, open: true };
    try {
      const result = await frames.run(frame, fn);
      db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      // An error SQLite rolled the whole transaction back for leaves no savepoint to roll back to.
      if (db.inTransaction) db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
      throw error;
    } finally {
      frame.open = false;
    }
  }

  return {
    dialect: "sqlite",
    async all<T>(text: string, params: readonly SqlValue[] = []) {
      // Inline, not in a helper: the statement must run in the same tick as the check that nothing is open.
      if (outside()) while (running) await running;
      return db.prepare(text).all(...params) as T[];
    },
    async get<T>(text: string, params: readonly SqlValue[] = []) {
      if (outside()) while (running) await running;
      return db.prepare(text).get(...params) as T | undefined;
    },
    async run(text: string, params: readonly SqlValue[] = []) {
      if (outside()) while (running) await running;
      return { changes: db.prepare(text).run(...params).changes };
    },
    async transaction<T>(fn: () => Promise<T>) {
      const parent = frames.getStore();
      if (parent?.open) return savepoint(parent.depth + 1, fn);
      while (running) await running;
      let end!: () => void;
      running = new Promise<void>((resolve) => { end = resolve; });
      const frame: Frame = { depth: 0, open: true };
      try {
        // IMMEDIATE takes the write lock now, so a write later in the transaction can't fail on another connection's.
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await frames.run(frame, fn);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          if (db.inTransaction) db.exec("ROLLBACK");
          throw error;
        }
      } finally {
        frame.open = false;
        running = null;
        end();
      }
    },
  };
}
