/**
 * Move a plugin database's reviews to Postgres and back with the storage CLI, as an operator would, and write what
 * shows they came back unchanged: the table checksums (scripts/store-reads.ts) of the source, the copy export-sqlite
 * writes and data.db once replaced, and the reads dump of the copy and of Postgres, to compare with the golden ones.
 *
 * Run from the repo root, with CRW_TEST_PG_URL naming a throwaway Postgres (scripts/test-postgres.sh):
 * `npx vite-node scripts/storage-round-trip.ts <data.db> <out dir>`.
 *
 * On a copy of `<data.db>`, in a fake host set to Postgres: `bb review storage migrate`. Then data.db's reviews are
 * replaced with junk, so they can only come back from Postgres, storageBackend is set to sqlite, the plugin reloads,
 * and `bb review storage export-sqlite --replace-data-db` and `bb review storage verify` run. It prints each command's
 * output and the RSS it peaked at, from a collected baseline when run with NODE_OPTIONS=--expose-gc, and drops its
 * Postgres schema at the end.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { pgSql } from "../src/db/pg";
import { testPgOptions, testSchemaName } from "../src/db/pg-test.test-support";
import { STORAGE_OWNER_KEY } from "../src/storage";
import { storeOn } from "../src/store";
import { queueStore } from "../src/store-queue";
import { dumpDatabase, dumpStoreReads, formatDump, storeEntities, tableChecksums } from "./store-reads";

// vite-node leaves the script's own path out of argv.
const [source, out] = process.argv.slice(2);
if (!source || !out) {
  process.stderr.write("Usage: CRW_TEST_PG_URL=… npx vite-node scripts/storage-round-trip.ts <data.db> <out dir>\n");
  process.exit(2);
}
if (existsSync(`${source}-wal`)) throw new Error(`${source} has a WAL file: use a consistent snapshot of it instead`);
mkdirSync(out, { recursive: true });

// RSS sampled while a command runs, which misses a peak between samples, and the process's own peak, which only rises.
let peakRss = 0;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
// maxRSS is in KiB.
const maxRss = () => process.resourceUsage().maxRSS * 1024;
const collect = (globalThis as { gc?: () => void }).gc ?? (() => {});
const write = (name: string, value: unknown) => { writeFileSync(join(out, name), typeof value === "string" ? value : formatDump(value)); };

const schema = testSchemaName();
const options = testPgOptions(schema);
const dataDir = mkdtempSync(join(tmpdir(), "crw-round-trip-"));
const { bb, harness } = createFakePluginHost({
  pluginId: "code-review-workspace", dataDir,
  settings: { storageBackend: "postgres", postgresUrl: options.url, postgresPassword: options.password as string, postgresSchema: schema, postgresSsl: "require" },
});
const admin = pgSql(testPgOptions("public"));
try {
  // The fake host's database, replaced by the copy before the plugin opens it, as scripts/store-reads.ts does.
  const empty = bb.storage.database();
  empty.close();
  copyFileSync(source, empty.name);
  const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
  const entities = storeEntities(sourceDb);
  sourceDb.close();

  await plugin(bb);
  const run = async (host: typeof harness, argv: string[]) => {
    collect();
    const rss = process.memoryUsage().rss;
    const processPeak = maxRss();
    peakRss = rss;
    const started = performance.now();
    const result = await host.behavior.runCli(argv);
    const ms = Math.round(performance.now() - started);
    const rose = maxRss() > processPeak ? `, the process's peak rose to ${mb(maxRss())}` : "";
    process.stdout.write(`\n$ bb review ${argv.join(" ")}   (exit ${result.exitCode}, ${ms} ms; RSS ${mb(rss)} before, ${mb(peakRss)} at most while it ran${rose})\n${result.stdout}\n${result.stderr ? `stderr: ${result.stderr}\n` : ""}`);
    if (result.exitCode !== 0) throw new Error(`bb review ${argv.join(" ")} failed`);
    return result.stdout;
  };
  await run(harness, ["storage", "migrate"]);

  // data.db's reviews, replaced with junk: whatever export-sqlite brings back comes from Postgres.
  const db = bb.storage.database();
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_bb_migrations', 'plugin_updates')`).pluck().all() as string[]);
  db.transaction(() => {
    for (const table of tables) db.prepare(`DELETE FROM "${table}"`).run();
    db.prepare(`UPDATE sqlite_sequence SET seq = 999`).run();
    db.prepare(`INSERT INTO reviews (target_key, kind, status, created_at) VALUES ('junk', 'pr', 'tracked', 1)`).run();
  })();

  await harness.behavior.setSettings({ storageBackend: "sqlite" });
  const next = await harness.lifecycle.reload(plugin);
  const exported = await run(next.harness, ["storage", "export-sqlite", "--replace-data-db"]);
  await run(next.harness, ["storage", "verify"]);
  const owner = await next.bb.storage.kv.get(STORAGE_OWNER_KEY);
  process.stdout.write(`\nstorage:owner: ${String(owner)}\n`);

  const exportFile = /^The copy: (.+)$/m.exec(exported)![1]!;
  const backupFile = /^Backed data\.db up to (.+)\.$/m.exec(exported)![1]!;
  const exportDb = new Database(exportFile, { readonly: true, fileMustExist: true });
  const backupDb = new Database(backupFile, { readonly: true, fileMustExist: true });
  const sourceAgain = new Database(source, { readonly: true, fileMustExist: true });
  const sourceChecksums = tableChecksums(sourceAgain);
  const checksums = { source: sourceChecksums, export: tableChecksums(exportDb), dataDb: tableChecksums(next.bb.storage.database()), backup: tableChecksums(backupDb) };
  for (const opened of [exportDb, backupDb, sourceAgain]) opened.close();
  for (const [name, value] of Object.entries(checksums)) write(`checksums-${name}.json`, value);
  const same = (a: unknown, b: unknown) => formatDump(a) === formatDump(b);
  process.stdout.write(`\nP3 table checksums: export ${same(checksums.export, sourceChecksums) ? "=" : "≠"} source, data.db ${same(checksums.dataDb, sourceChecksums) ? "=" : "≠"} source, backup ${same(checksums.backup, sourceChecksums) ? "=" : "≠"} source\n`);

  // The reads dump of the copy, through SQLite's store, and of Postgres, through the Store on it.
  const { reads, checksums: exportReadChecksums } = await dumpDatabase(exportFile);
  write("dump-export.json", reads);
  write("dump-export-checksums.json", exportReadChecksums);
  const connection = pgSql(options);
  const store = queueStore(storeOn(connection));
  write("dump-postgres.json", formatDump(await dumpStoreReads(store, entities)));
  await store.dispose();
  await connection.end();
  await next.harness.lifecycle.dispose();
  process.stdout.write(`\nThe process's peak RSS: ${mb(maxRss())}\nWritten to ${out}\n`);
} finally {
  clearInterval(sampler);
  await harness.lifecycle.dispose();
  await admin.run(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
  rmSync(dataDir, { recursive: true, force: true });
}
