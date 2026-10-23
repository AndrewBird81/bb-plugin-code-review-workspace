// bb review storage: where the reviews are kept, and moving them between SQLite and Postgres. status and verify answer
// in any state and change nothing. migrate and export-sqlite run in maintenance, where the plugin serves nothing else,
// so nothing reads or writes the reviews while they move; they run from a terminal, not from a thread.
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import { pgSql, type PgSql } from "./db/pg";
import { migratePg } from "./db/pg-migrations";
import { migrateSqlite } from "./store";
import { describe, pgOptions, redactor, STORAGE_OWNER_KEY, type StorageChoice, type StorageStatus } from "./storage";
import {
  copyToPostgres, copyToSqlite, differences, pgChecksums, pgMigrationProblems, pgTables, pgTablesWithRows, schemaProblems, sqliteChecksums,
  sqliteMigrationProblems, sqliteTables, sqliteValueProblems, stopIfAborted, StorageProblems, type Checksums, type Copied, type Table,
} from "./storage-copy";

export const STORAGE_USAGE = [
  "usage: bb review storage status",
  "       bb review storage verify",
  "       bb review storage migrate",
  "       bb review storage export-sqlite [--replace-data-db]",
  "",
  "Shows where Code Review Workspace keeps its reviews, and moves them between SQLite and Postgres.",
  "  status         the backend the settings choose (storageBackend), the one holding the reviews (storage:owner), and whether the plugin serves from it",
  "  verify         compare every table's rows, and each next id, in SQLite's data.db and in Postgres; changes nothing",
  "  migrate        copy the reviews from SQLite to an empty Postgres schema, check the copy, then mark Postgres as holding them.",
  "                 In maintenance, with storageBackend set to postgres and the reviews in SQLite",
  "  export-sqlite  copy the reviews from Postgres to a new SQLite file beside data.db, and check the copy.",
  "                 In maintenance, with the reviews in Postgres",
  "    --replace-data-db  then back data.db up beside it, replace its reviews with the copy, and mark SQLite as holding them;",
  "                       with storageBackend set to sqlite",
  "migrate and export-sqlite run from a terminal, not from a thread.",
].join("\n");

type CliResult = { exitCode: number; stdout?: string; stderr?: string };

const STATE: Record<StorageStatus["state"], string> = {
  serving: "serving",
  opening: "opening Postgres; only bb review storage answers until it's open",
  maintenance: "maintenance; only bb review storage answers",
};

const usage = (problem: string): CliResult => ({ exitCode: 2, stderr: `${problem}\n${STORAGE_USAGE}` });

// The attached SQLite file export-sqlite writes.
const EXPORT = "crw_export";

/**
 * The paths of a new export, and of data.db's backup, beside data.db: named for the time to the second, UTC, and
 * numbered after it when either name is taken.
 */
function exportPaths(dir: string) {
  const at = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  for (let n = 1; ; n++) {
    const name = n === 1 ? at : `${at}-${n}`;
    const paths = { exported: join(dir, `data-export-${name}.db`), backup: join(dir, `data-backup-${name}.db`) };
    if (!existsSync(paths.exported) && !existsSync(paths.backup)) return paths;
  }
}

/**
 * `bb review storage …`, for the plugin whose storage `storage` chose. Only one of its commands runs at a time, and a
 * reload stops a running migrate or export-sqlite before it commits, as a cancelled command does.
 */
export function createStorageCommand(bb: BbPluginApi, storage: StorageChoice) {
  const { status, settings } = storage;
  const redact = redactor(settings);
  const reload = `bb plugin reload ${bb.pluginId}`;
  const disposed = new AbortController();
  bb.onDispose(() => { disposed.abort(); });
  let running: string | null = null;

  /** Why `command` can't run in this state, or null. */
  function refusal(command: "migrate" | "export-sqlite", replace: boolean): string | null {
    if (status.owner !== "sqlite" && status.owner !== "postgres") {
      return `storage:owner is ${status.owner}, which this version doesn't know: update the plugin.`;
    }
    const where = status.owner === "sqlite" ? "SQLite" : "Postgres";
    if (command === "migrate") {
      if (status.owner === "postgres") return `The reviews are in Postgres already (storage:owner).`;
      if (status.state !== "maintenance") return `The plugin is serving the reviews from SQLite. To move them to Postgres, set storageBackend to postgres and the Postgres settings, reload (${reload}), then run bb review storage migrate.`;
      return null;
    }
    if (status.owner === "sqlite") return `The reviews are in SQLite already (storage:owner).`;
    if (status.state !== "maintenance") return `The plugin ${status.state === "opening" ? "opens" : "serves"} the reviews from ${where}. To copy them to SQLite, set storageBackend to sqlite, reload (${reload}), then run bb review storage export-sqlite.`;
    if (replace && status.configured !== "sqlite") return `--replace-data-db makes SQLite hold the reviews, so it runs with storageBackend set to sqlite: set it, reload (${reload}), then run it again.`;
    return null;
  }

  return async function run(argv: string[], ctx: PluginCliContext = {}): Promise<CliResult> {
    if (argv.some((arg) => arg === "--help" || arg === "-h")) return { exitCode: 0, stdout: STORAGE_USAGE };
    const [command, ...rest] = argv;
    if (!command) return usage("Give a storage command.");
    if (command !== "status" && command !== "verify" && command !== "migrate" && command !== "export-sqlite") return usage(`Unknown storage command: ${argv.join(" ")}`);
    const flag = rest.find((arg) => command !== "export-sqlite" || arg !== "--replace-data-db");
    if (flag !== undefined) return usage(`storage ${command} doesn't take ${flag}.`);
    if (rest.length > 1) return usage("--replace-data-db is given twice.");
    if (command === "status") return statusOf(status);
    const replace = rest.length === 1;
    if ((command === "migrate" || command === "export-sqlite") && ctx.threadId) {
      return { exitCode: 1, stderr: `bb review storage ${command} moves every review, so it runs from a terminal, not from a thread.` };
    }
    if (running) return { exitCode: 1, stderr: `bb review storage ${running} is running; try again once it's done.` };
    const refused = command === "verify" ? null : refusal(command, replace);
    if (refused) return { exitCode: 1, stderr: refused };

    running = command;
    const out: string[] = [];
    const say = (line: string) => { out.push(line); };
    // Each table is in BB's log as it's done, for a command whose terminal has gone.
    const progress = (line: string) => { say(line); bb.log.info(`bb review storage ${command}: ${line.trim()}`); };
    const signal = AbortSignal.any([disposed.signal, ...ctx.signal ? [ctx.signal] : []]);
    let pg: PgSql | null = null;
    try {
      try {
        // A connection of its own, beside the store's when the plugin serves from Postgres.
        pg = pgSql({ ...pgOptions(settings), applicationName: "code-review-workspace storage", timeouts: { writerLockMs: 5_000 } });
      } catch (error) {
        return { exitCode: 1, stderr: `bb review storage ${command} needs the Postgres settings: ${redact(describe(error))}.` };
      }
      const exitCode = command === "verify" ? await verify(pg, signal, say, progress)
        : command === "migrate" ? await migrate(pg, signal, say, progress)
          : await exportSqlite(pg, replace, signal, say, progress);
      return { exitCode, stdout: out.join("\n") };
    } catch (error) {
      const failed = error instanceof StorageProblems
        ? `${command === "verify" ? "Can't compare SQLite and Postgres" : command === "migrate" ? "Nothing was copied" : "Nothing was exported"}:\n${error.problems.map((problem) => `  - ${problem}`).join("\n")}`
        : error instanceof OwnerNotMarked ? redact(error.message)
          : `${redact(describe(error))}.${command === "verify" ? "" : " Nothing was changed."}`;
      return { exitCode: 1, ...out.length ? { stdout: out.join("\n") } : {}, stderr: failed };
    } finally {
      running = null;
      await pg?.end();
    }
  };

  /** Mark `owner` as holding the reviews, once they're there, or say what's done and what isn't. */
  async function markOwner(owner: "sqlite" | "postgres", done: string) {
    try {
      await bb.storage.kv.set(STORAGE_OWNER_KEY, owner);
    } catch (error) {
      throw new OwnerNotMarked(`${done}: ${describe(error)}. Run the command again once BB answers.`);
    }
    status.owner = owner;
  }

  /** Compare SQLite and Postgres, reading each as it is: Postgres in one snapshot, SQLite a page at a time. */
  async function verify(pg: PgSql, signal: AbortSignal, say: (line: string) => void, progress: (line: string) => void): Promise<number> {
    const schema = settings.postgresSchema;
    const db = bb.storage.database();
    say(`Comparing SQLite's data.db with Postgres schema "${schema}".`);
    if (status.state === "serving") say(`The plugin serves the reviews from ${status.owner === "sqlite" ? "SQLite" : "Postgres"}, so they may have changed since the other was copied.`);
    return pg.transaction(async () => {
      await pg.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const tables = sqliteTables(db);
      const problems = [...sqliteMigrationProblems(db), ...await pgMigrationProblems(pg, schema)];
      if (!problems.length) problems.push(...schemaProblems(tables, (await pgTables(pg, schema)).tables));
      if (problems.length) throw new StorageProblems(problems);
      const started = performance.now();
      const fromPostgres = await pgChecksums(pg, schema, tables, signal);
      const fromSqlite = await sqliteChecksums(db, "main", tables, signal);
      for (const line of comparison(tables, fromSqlite, fromPostgres)) progress(line);
      const differ = differences(fromSqlite, fromPostgres);
      say(differ.length
        ? `Different in SQLite and Postgres: ${differ.join(", ")}.`
        : `The same in SQLite and Postgres: ${summary(tables, fromSqlite)}, in ${Math.round(performance.now() - started)} ms.`);
      return differ.length ? 1 : 0;
    });
  }

  /**
   * Copy SQLite's reviews to Postgres, in one transaction whose tables were empty, check the copy before it commits,
   * then mark Postgres as holding them. Tables that hold exactly SQLite's reviews already, a copy whose marking failed,
   * are only marked. SQLite's write lock is held throughout, so nothing changes it meanwhile.
   */
  async function migrate(pg: PgSql, signal: AbortSignal, say: (line: string) => void, progress: (line: string) => void): Promise<number> {
    const schema = settings.postgresSchema;
    // SQLite's tables as SQLite storage would open them, so an install set to Postgres from the start has them too.
    const db = migrateSqlite(bb);
    db.exec("BEGIN IMMEDIATE");
    try {
      await pg.lockWriter();
      say(`Copying the reviews from SQLite's data.db to Postgres schema "${schema}".`);
      const started = performance.now();
      const copied = await pg.transaction(async () => {
        await migratePg(pg, schema);
        const tables = sqliteTables(db);
        const { tables: inPostgres, types } = await pgTables(pg, schema);
        const problems = [...sqliteMigrationProblems(db), ...await pgMigrationProblems(pg, schema), ...schemaProblems(tables, inPostgres)];
        if (problems.length) throw new StorageProblems(problems);
        problems.push(...sqliteValueProblems(db, tables, types));
        const held = await pgTablesWithRows(pg, tables);
        if (problems.length) throw new StorageProblems(problems);
        if (held.length) {
          // A copy whose owner wasn't marked, as when the plugin reloaded just after it committed, is marked now; any
          // other is refused.
          const fromSqlite = await sqliteChecksums(db, "main", tables, signal);
          const differ = differences(fromSqlite, await pgChecksums(pg, schema, tables, signal));
          if (differ.length) {
            throw new StorageProblems([`Postgres schema "${schema}" holds reviews already, in ${held.join(", ")}, and they differ from SQLite's in ${differ.join(", ")}. Drop its tables, or set postgresSchema to a new schema and reload (${reload}).`]);
          }
          stopIfAborted(signal);
          return { resumed: true, tables, sums: fromSqlite };
        }
        await copyToPostgres(db, pg, schema, tables, signal, (table) => { progress(copiedLine(tables, table)); });
        const checked = check(tables, await sqliteChecksums(db, "main", tables, signal), await pgChecksums(pg, schema, tables, signal));
        stopIfAborted(signal);
        return { resumed: false, ...checked };
      });
      await markOwner("postgres", `Postgres holds the reviews, copied and checked, but storage:owner couldn't be set to postgres`);
      status.problem = `The reviews are in Postgres now: reload the plugin to serve them from it (${reload}).`;
      say(copied.resumed
        ? `Postgres already holds an identical, checked copy; only the owner was switched. The same in SQLite and Postgres: ${summary(copied.tables, copied.sums)}.`
        : `Copied and checked, the same in SQLite and Postgres: ${summary(copied.tables, copied.sums)}, in ${Math.round(performance.now() - started)} ms.`);
      say(`storage:owner is postgres now. Reload the plugin to serve the reviews from Postgres: ${reload}`);
      return 0;
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
    }
  }

  /**
   * Copy Postgres's reviews to a new file beside data.db: a copy of data.db, whose own tables (BB's migrations record,
   * plugin_updates) it keeps, with the Store's tables replaced by Postgres's and checked. With `replace`, data.db is
   * then backed up beside it, and its Store tables replaced from the copy in one transaction, checked before it commits,
   * and SQLite marked as holding the reviews.
   */
  async function exportSqlite(pg: PgSql, replace: boolean, signal: AbortSignal, say: (line: string) => void, progress: (line: string) => void): Promise<number> {
    const schema = settings.postgresSchema;
    const db = migrateSqlite(bb);
    const { exported, backup } = exportPaths(dirname(db.name));
    // The writer lock keeps another BB from writing to Postgres until SQLite holds the reviews.
    if (replace) await pg.lockWriter();
    say(`Copying the reviews from Postgres schema "${schema}" to ${exported}.`);
    const started = performance.now();
    let attached = false;
    // Once data.db's reviews are replaced, the copy stays, whatever happens next.
    let kept = false;
    try {
      db.prepare("VACUUM INTO ?").run(exported);
      db.prepare(`ATTACH DATABASE ? AS ${EXPORT}`).run(exported);
      attached = true;
      await pg.transaction(async () => {
        await pg.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        const tables = sqliteTables(db, EXPORT);
        const problems = [...sqliteMigrationProblems(db, EXPORT), ...await pgMigrationProblems(pg, schema)];
        if (!problems.length) problems.push(...schemaProblems(tables, (await pgTables(pg, schema)).tables));
        if (problems.length) throw new StorageProblems(problems);
        await copyToSqlite(pg, schema, db, EXPORT, tables, signal, (table) => { progress(copiedLine(tables, table)); });
        const fromPostgres = await pgChecksums(pg, schema, tables, signal);
        const checked = check(tables, await sqliteChecksums(db, EXPORT, tables, signal), fromPostgres);
        // Without the pages the copy's former rows left behind.
        db.exec(`VACUUM ${EXPORT}`);
        say(`Exported and checked, the same in Postgres and the copy: ${summary(checked.tables, checked.sums)}, in ${Math.round(performance.now() - started)} ms.`);
        if (!replace) return;
        stopIfAborted(signal);
        db.prepare("VACUUM main INTO ?").run(backup);
        progress(`Backed data.db up to ${backup}.`);
        db.exec("BEGIN IMMEDIATE");
        try {
          replaceFromExport(db, tables);
          check(tables, await sqliteChecksums(db, "main", tables, signal), fromPostgres);
          stopIfAborted(signal);
          db.exec("COMMIT");
          kept = true;
        } finally {
          if (db.inTransaction) db.exec("ROLLBACK");
          if (!kept) rmSync(backup, { force: true });
        }
        await markOwner("sqlite", `data.db holds Postgres's reviews, checked, and its former ones are in ${backup}, but storage:owner couldn't be set to sqlite`);
        status.problem = `The reviews are in SQLite now: reload the plugin to serve them from it (${reload}).`;
        say("Replaced data.db's reviews with the copy, and checked them.");
        say(`storage:owner is sqlite now. Reload the plugin to serve the reviews from SQLite: ${reload}`);
      });
      kept = true;
    } finally {
      // A reload closes the database, the copy's attachment with it.
      if (attached && db.open) db.exec(`DETACH DATABASE ${EXPORT}`);
      if (!kept) for (const file of [exported, `${exported}-journal`]) rmSync(file, { force: true });
    }
    say(`The copy: ${exported}`);
    return 0;
  }
}

/** The reviews are moved and checked, but storage:owner doesn't say so. */
class OwnerNotMarked extends Error {}

/** The checksums compared: the tables and their sums, or StorageProblems naming what differs. */
function check(tables: Table[], copy: Checksums, source: Checksums) {
  const differ = differences(copy, source);
  if (differ.length) throw new StorageProblems([`The copy differs in ${differ.join(", ")}: it was rolled back.`]);
  return { tables, sums: copy };
}

/** Replace data.db's Store tables, and their sqlite_sequence rows, with the export's. Inside a transaction. */
function replaceFromExport(db: ReturnType<BbPluginApi["storage"]["database"]>, tables: Table[]) {
  for (const table of tables) {
    const name = `"${table.name}"`;
    const columns = table.columns.map((column) => `"${column.name}"`).join(", ");
    db.prepare(`DELETE FROM main.${name}`).run();
    db.prepare(`INSERT INTO main.${name} (${columns}) SELECT ${columns} FROM ${EXPORT}.${name}`).run();
    if (!table.identity) continue;
    db.prepare(`DELETE FROM main.sqlite_sequence WHERE name = ?`).run(table.name);
    db.prepare(`INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM ${EXPORT}.sqlite_sequence WHERE name = ?`).run(table.name);
  }
}

const width = (tables: Table[]) => Math.max(...tables.map((table) => table.name.length));

function copiedLine(tables: Table[], { table, rows, ms, nextId }: Copied): string {
  return `  ${table.padEnd(width(tables))}  ${String(rows).padStart(7)} ${rows === 1 ? "row " : "rows"}  ${String(ms).padStart(6)} ms${nextId === undefined ? "" : `  next id ${nextId}`}`;
}

/** Each table's rows, and each next id, in SQLite and in Postgres, and whether they're the same. */
function comparison(tables: Table[], sqlite: Checksums, postgres: Checksums): string[] {
  const pad = Math.max(width(tables), ...[...sqlite.nextIds.keys()].map((name) => `${name} next id`.length));
  const line = (name: string, a: number | undefined, b: number | undefined, same: boolean) =>
    `  ${name.padEnd(pad)}  ${String(a ?? "-").padStart(7)}  ${String(b ?? "-").padStart(8)}  ${same ? "same" : "DIFFERENT"}`;
  return [
    `  ${"".padEnd(pad)}  ${"SQLite".padStart(7)}  ${"Postgres".padStart(8)}`,
    ...tables.map(({ name }) => {
      const [a, b] = [sqlite.tables.get(name), postgres.tables.get(name)];
      return line(name, a?.rows, b?.rows, a?.rows === b?.rows && a?.sha256 === b?.sha256);
    }),
    ...[...sqlite.nextIds.keys()].map((name) => line(`${name} next id`, sqlite.nextIds.get(name), postgres.nextIds.get(name), sqlite.nextIds.get(name) === postgres.nextIds.get(name))),
  ];
}

function summary(tables: Table[], sums: Checksums): string {
  const rows = [...sums.tables.values()].reduce((total, sum) => total + sum.rows, 0);
  return `${tables.length} tables, ${rows} rows, and ${sums.nextIds.size} next ids`;
}

function statusOf(status: StorageStatus): CliResult {
  return { exitCode: 0, stdout: [
    `storageBackend: ${status.configured}`,
    `${STORAGE_OWNER_KEY}: ${status.owner}`,
    `state: ${STATE[status.state]}`,
    ...status.problem ? [`problem: ${status.problem}`] : [],
  ].join("\n") };
}
