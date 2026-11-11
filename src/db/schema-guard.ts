import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface MigrationRecord { id: number; statement_hash: string | null }

/** Refuse incompatible history before either migrator writes; trailing unapplied statements are upgrades. */
export function assertMigrationLedger(applied: MigrationRecord[], statements: readonly string[], backend: string): void {
  for (const { id, statement_hash: hash } of applied) {
    if (id < 0 || id >= statements.length) {
      throw new Error(`database is from a newer Code Review Workspace (migration ${id}); update the plugin`);
    }
    // Older SQLite ledgers have no hashes; the host migrator adopts those statements as before.
    if (hash !== null && hash !== createHash("sha256").update(statements[id]!).digest("hex")) {
      throw new Error(`${backend} migration ${id} does not match the statement it recorded; append a new migration instead of changing or reusing an index`);
    }
  }
}

/** Read only, including ledgers from before the host recorded statement hashes. */
export function assertSqliteLedger(db: ReturnType<BbPluginApi["storage"]["database"]>, statements: readonly string[], schema = "main"): void {
  if (!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name='_bb_migrations'`).get()) return;
  const columns = db.prepare(`PRAGMA ${schema}.table_info(_bb_migrations)`).all() as Array<{ name: string }>;
  const hash = columns.some((column) => column.name === "statement_hash") ? "statement_hash" : "NULL AS statement_hash";
  assertMigrationLedger(db.prepare(`SELECT id, ${hash} FROM ${schema}._bb_migrations ORDER BY id`).all() as MigrationRecord[], statements, "SQLite");
}
