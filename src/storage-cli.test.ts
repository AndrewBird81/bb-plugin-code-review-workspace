// bb review storage: its commands' refusals on the fake host, and against the Postgres CRW_TEST_PG_URL names, the
// reviews moved from SQLite to Postgres and back, checked, each test in a schema of its own.
import { afterEach, describe, expect, test, vi } from "vitest";

// The copy reads data.db as SQLite storage makes it, with SQLite's own store.
vi.unmock("./store");

const hooks = vi.hoisted(() => ({
  /** Awaited before each statement run, outside the reads: a test's way to stop a copy at a statement. */
  beforeRun: undefined as ((text: string, params: readonly unknown[]) => Promise<void> | void) | undefined,
  /** Called once each read's rows are back. */
  afterAll: undefined as ((text: string) => void) | undefined,
}));

vi.mock("./db/pg", async (original) => {
  const actual = await original<typeof import("./db/pg")>();
  return {
    ...actual,
    pgSql(options: import("./db/pg").PgOptions) {
      // A held writer lock fails in under a second rather than five.
      const made = actual.pgSql({ ...options, timeouts: { ...options.timeouts, writerLockMs: 400 } });
      return {
        ...made,
        async run(text: string, params: readonly import("./db/sql").SqlValue[] = []) {
          await hooks.beforeRun?.(text, params);
          return made.run(text, params);
        },
        async all<T>(text: string, params: readonly import("./db/sql").SqlValue[] = []) {
          const rows = await made.all<T>(text, params);
          hooks.afterAll?.(text);
          return rows;
        },
      };
    },
  };
});

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { tableChecksums } from "../scripts/store-reads";
import { pgSql, type PgSql } from "./db/pg";
import { migratePg } from "./db/pg-migrations";
import { sqliteSql, type Sql } from "./db/sql";
import { testPgOptions, testPgUrl, testSchemaName } from "./db/pg-test.test-support";
import { STORAGE_OWNER_KEY } from "./storage";
import { STORAGE_USAGE } from "./storage-cli";
import { pgTablesWithRows, sqliteTables } from "./storage-copy";
import { createStore, migrateSqlite } from "./store";
import { queueStore } from "./store-queue";

const PLUGIN = "code-review-workspace";
const PASSWORD = "s3cret-pass-p11";

const ended: PgSql[] = [];
const schemas: string[] = [];

afterEach(async () => {
  hooks.beforeRun = undefined;
  hooks.afterAll = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(ended.splice(0).map((connection) => connection.end()));
  if (!schemas.length) return;
  const admin = pgSql(testPgOptions("public"));
  try {
    for (const schema of schemas.splice(0)) await admin.run(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.end();
  }
});

async function host(settings: Record<string, string> = {}, owner?: string) {
  const { bb, harness } = createFakePluginHost({ pluginId: PLUGIN, settings });
  if (owner !== undefined) await bb.storage.kv.set(STORAGE_OWNER_KEY, owner);
  return { bb, harness };
}

const run = (harness: FakePluginHarness, ...argv: string[]) => harness.behavior.runCli(["storage", ...argv]);

describe("bb review storage, refusing what it can't do", () => {
  test("--help shows every command, and a wrong one, or a flag it doesn't take, is a usage error", async () => {
    const { bb, harness } = await host();
    await plugin(bb);
    expect(await run(harness, "--help")).toEqual({ exitCode: 0, stdout: STORAGE_USAGE, stderr: "" });
    expect(await run(harness, "migrate", "-h")).toEqual({ exitCode: 0, stdout: STORAGE_USAGE, stderr: "" });
    for (const usage of ["status", "verify", "migrate", "export-sqlite [--replace-data-db]"]) expect(STORAGE_USAGE).toContain(`bb review storage ${usage}`);
    for (const [argv, says] of [
      [[], "Give a storage command."],
      [["move"], "Unknown storage command: move"],
      [["migrate", "--replace-data-db"], "storage migrate doesn't take --replace-data-db."],
      [["verify", "now"], "storage verify doesn't take now."],
      [["export-sqlite", "--force"], "storage export-sqlite doesn't take --force."],
      [["export-sqlite", "--replace-data-db", "--replace-data-db"], "--replace-data-db is given twice."],
    ] as const) {
      expect(await run(harness, ...argv)).toEqual({ exitCode: 2, stdout: "", stderr: `${says}\n${STORAGE_USAGE}` });
    }
  });

  test("migrate and export-sqlite are refused from a thread, whatever state storage is in; status and verify answer it", async () => {
    const { bb, harness } = await host({ storageBackend: "postgres", postgresUrl: "postgres://crw@db.example:5432/crw", postgresPassword: PASSWORD });
    await plugin(bb);
    const fromThread = { threadId: "thread-1" };
    expect(await harness.behavior.runCli(["storage", "migrate"], fromThread)).toEqual({ exitCode: 1, stdout: "", stderr: "bb review storage migrate moves every review, so it runs from a terminal, not from a thread." });
    expect(await harness.behavior.runCli(["storage", "export-sqlite", "--replace-data-db"], fromThread)).toEqual({ exitCode: 1, stdout: "", stderr: "bb review storage export-sqlite moves every review, so it runs from a terminal, not from a thread." });
    expect(await harness.behavior.runCli(["storage", "status"], fromThread)).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("state: maintenance") });
    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBeUndefined();
    expect(sqliteHasReviews(bb)).toBe(false);
  });

  test.each([
    {
      name: "migrate, serving from SQLite", settings: {}, owner: undefined, argv: ["migrate"],
      says: "The plugin is serving the reviews from SQLite. To move them to Postgres, set storageBackend to postgres and the Postgres settings, reload (bb plugin reload code-review-workspace), then run bb review storage migrate.",
    },
    { name: "migrate, the reviews in Postgres", settings: { storageBackend: "sqlite" }, owner: "postgres", argv: ["migrate"], says: "The reviews are in Postgres already (storage:owner)." },
    { name: "export-sqlite, serving from SQLite", settings: {}, owner: "sqlite", argv: ["export-sqlite"], says: "The reviews are in SQLite already (storage:owner)." },
    { name: "export-sqlite, the reviews in SQLite", settings: { storageBackend: "postgres" }, owner: undefined, argv: ["export-sqlite"], says: "The reviews are in SQLite already (storage:owner)." },
    {
      name: "export-sqlite --replace-data-db, storage set to Postgres", settings: { storageBackend: "postgres" }, owner: "postgres", argv: ["export-sqlite", "--replace-data-db"],
      says: "--replace-data-db makes SQLite hold the reviews, so it runs with storageBackend set to sqlite: set it, reload (bb plugin reload code-review-workspace), then run it again.",
    },
    { name: "migrate, an owner this version doesn't know", settings: { storageBackend: "postgres" }, owner: "mysql", argv: ["migrate"], says: "storage:owner is mysql, which this version doesn't know: update the plugin." },
    { name: "export-sqlite, an owner this version doesn't know", settings: { storageBackend: "sqlite" }, owner: "mysql", argv: ["export-sqlite"], says: "storage:owner is mysql, which this version doesn't know: update the plugin." },
  ])("$name: refused, changing nothing", async ({ settings, owner, argv, says }) => {
    const { bb, harness } = await host(settings as Record<string, string>, owner);
    await plugin(bb);
    const tables = () => bb.storage.database().prepare("SELECT name FROM sqlite_master ORDER BY name").pluck().all();
    const before = tables();
    expect(await run(harness, ...argv)).toEqual({ exitCode: 1, stdout: "", stderr: says });
    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBe(owner);
    expect(tables()).toEqual(before);
  });

  test("without complete Postgres settings, verify and migrate say which is missing, never the URL or password", async () => {
    const serving = await host();
    await plugin(serving.bb);
    expect(await run(serving.harness, "verify")).toEqual({ exitCode: 1, stdout: "", stderr: "bb review storage verify needs the Postgres settings: postgresUrl is not set: postgres://user@host:port/database." });
    const url = "postgres://crw@db.example:5432/crw";
    const { bb, harness } = await host({ storageBackend: "postgres", postgresUrl: url });
    await plugin(bb);
    expect(await run(harness, "migrate")).toEqual({ exitCode: 1, stdout: "", stderr: "bb review storage migrate needs the Postgres settings: postgresPassword is not set." });
    const withPassword = await host({ storageBackend: "postgres", postgresUrl: `postgres://crw:${PASSWORD}@db.example:5432/crw`, postgresPassword: PASSWORD });
    await plugin(withPassword.bb);
    const { stderr } = await run(withPassword.harness, "migrate");
    expect(stderr).toMatch(/^bb review storage migrate needs the Postgres settings: postgresUrl holds a password/);
    expect(stderr).not.toContain(PASSWORD);
    expect(stderr).not.toContain("db.example");
  });
});

// What the copy is tried on: three rows in every Store table, with the text and numbers that are easy to get wrong.
const TEXTS = ["", `it's "quoted" ?, $1 -- ; ünïcödé 😀\r\n\ttab`, `${"x".repeat(3000)}é`];
// They sort one way by code point, as both backends do, and another in most locales.
const KEYS = ["B.ts", "a.ts", "ä.ts"];
const BIG = [0, 1_792_533_018_614, Number.MAX_SAFE_INTEGER];
const SMALL = [1, -7, 2_147_483_647];
// 5 MiB of two-byte text, past a page of its own, and three rows of 1.5 MiB, which take two pages.
const HUGE = "é".repeat(5 * 512 * 1024);
const LARGE = (i: number) => `${i}${"ab".repeat(768 * 1024)}`;

/** data.db with the Store's tables, every one seeded, and AUTOINCREMENT's records of ids given as P0 found them, and odder. */
function seed(bb: BbPluginApi) {
  const db = migrateSqlite(bb);
  const tables = sqliteTables(db);
  db.transaction(() => {
    for (const table of tables) {
      const nullable = new Set(db.prepare(`SELECT name FROM pragma_table_info(?) WHERE "notnull" = 0 AND pk = 0`).pluck().all(table.name) as string[]);
      const insert = db.prepare(`INSERT INTO "${table.name}" (${table.columns.map((c) => `"${c.name}"`).join(", ")}) VALUES (${table.columns.map(() => "?").join(", ")})`);
      for (let i = 0; i < (table.name === "review_preferences" ? 1 : 3); i++) {
        insert.run(...table.columns.map(({ name, type }) => {
          if (name === table.identity) return [5, 9, 12][i];
          if (table.name === "review_preferences" && name === "id") return 1;
          if (nullable.has(name) && i === 2) return null;
          if (type === "integer") return name === "recorded" ? i % 2 : name === "at" || name === "revision" || name.endsWith("_at") ? BIG[i] : SMALL[i];
          return table.key.includes(name) ? KEYS[i] : TEXTS[i];
        }));
      }
    }
    db.prepare(`INSERT INTO patches (target_key, patch, hash) VALUES ('huge', ?, NULL)`).run(HUGE);
    for (const i of [1, 2, 3]) db.prepare(`INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('large', ?, ?, ?)`).run(`h${i}`, LARGE(i), i);
    // Ids given past the highest left, as discussion_entries' were (P0: 46 given, 10 left); none left, with 0 given;
    // and ids with no record of what was given.
    db.prepare(`UPDATE sqlite_sequence SET seq = 46 WHERE name = 'discussion_entries'`).run();
    db.prepare(`DELETE FROM agent_messages`).run();
    db.prepare(`UPDATE sqlite_sequence SET seq = 0 WHERE name = 'agent_messages'`).run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'agent_comment_changes'`).run();
    // plugin_updates stays in SQLite: it's neither copied nor replaced.
    db.exec("CREATE TABLE IF NOT EXISTS plugin_updates (id INTEGER PRIMARY KEY CHECK(id=1), automatic INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0)");
    db.prepare("INSERT INTO plugin_updates (id, automatic, next_attempt) VALUES (1, 1, 42)").run();
  })();
  return { db, tables: tables.map((table) => table.name) };
}

/** The id each identity gives next, the store's tables as seed left them. */
const NEXT_IDS = { agent_comment_changes: 13, agent_comment_outcomes: 13, agent_messages: 1, discussion_entries: 47 };

/** Every row of `tables`, as sorted JSON per table. */
async function rows(sql: Sql, tables: readonly string[]) {
  const all: Record<string, string[]> = {};
  for (const table of tables) all[table] = (await sql.all(`SELECT * FROM "${table}"`)).map((row) => JSON.stringify(Object.entries(row as object).sort())).sort();
  return all;
}

const sqliteHasReviews = (bb: BbPluginApi) => !!bb.storage.database().prepare("SELECT 1 FROM sqlite_master WHERE name = 'reviews'").get();

/** The plugin's settings for Postgres storage in a new schema, and that schema. */
function postgresSettings() {
  const schema = testSchemaName();
  schemas.push(schema);
  const options = testPgOptions(schema);
  return { schema, settings: { storageBackend: "postgres", postgresUrl: options.url, postgresPassword: options.password as string, postgresSchema: schema, postgresSsl: "require" } };
}

function connection(schema: string): PgSql {
  const made = pgSql(testPgOptions(schema));
  ended.push(made);
  return made;
}

const schemaExists = async (schema: string) => !!await connection("public").get(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, [schema]);

/** Where each page of a copy's rows went: one INSERT each, with how many rows and text bytes. */
function watchInserts() {
  const inserts: Array<{ table: string; rows: number; bytes: number }> = [];
  hooks.beforeRun = (text, params) => {
    const into = /^INSERT INTO "(\w+)" \(([^)]*)\) VALUES /.exec(text);
    if (into) inserts.push({ table: into[1]!, rows: params.length / into[2]!.split(",").length, bytes: params.reduce<number>((sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0) });
  };
  return inserts;
}

/** A promise `hooks.beforeRun` settles at the first INSERT into `table`, holding it there until `release`. */
function holdAt(table: string) {
  let reached!: () => void;
  let release!: () => void;
  const at = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  hooks.beforeRun = async (text) => {
    if (!text.startsWith(`INSERT INTO "${table}"`)) return;
    hooks.beforeRun = undefined;
    reached();
    await held;
  };
  return { at, release };
}

describe.skipIf(!testPgUrl)("bb review storage, moving the reviews (CRW_TEST_PG_URL)", () => {
  test("migrate copies every table to Postgres in pages, with its ids, each identity giving the id SQLite would give next, checks them, then marks Postgres as holding the reviews", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    const { db, tables } = seed(bb);
    const before = tableChecksums(db);
    await plugin(bb);
    const inserts = watchInserts();
    const { exitCode, stdout, stderr } = await run(harness, "migrate");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n");
    expect(lines[0]).toBe(`Copying the reviews from SQLite's data.db to Postgres schema "${schema}".`);
    // A line for each table, with its rows, time and next id.
    expect(lines.filter((line) => /^ {2}\w+ +\d+ rows? +\d+ ms/.test(line))).toHaveLength(tables.length);
    expect(stdout).toMatch(/^ {2}review_preferences +1 row +\d+ ms$/m);
    expect(stdout).toMatch(/^ {2}discussion_entries +3 rows +\d+ ms {2}next id 47$/m);
    expect(stdout).toMatch(/^ {2}patches +4 rows +\d+ ms$/m);
    expect(lines.at(-2)).toMatch(new RegExp(`^Copied and checked, the same in SQLite and Postgres: ${tables.length} tables, \\d+ rows, and 4 next ids, in \\d+ ms\\.$`));
    expect(lines.at(-1)).toBe("storage:owner is postgres now. Reload the plugin to serve the reviews from Postgres: bb plugin reload code-review-workspace");
    for (const said of [stdout, ...harness.inspection.logEntries.map((entry) => entry.message)]) {
      expect(said).not.toContain(PASSWORD);
      expect(said).not.toContain(settings.postgresUrl);
      expect(said).not.toContain(settings.postgresPassword);
    }
    expect(harness.inspection.logEntries).toContainEqual({ level: "info", message: expect.stringMatching(/^bb review storage migrate: reviews +3 rows +\d+ ms$/) });

    // Pages: no INSERT past 4 MiB of text unless it's a single row, and the 1.5 MiB rows in more than one.
    for (const insert of inserts) if (insert.rows > 1) expect(insert.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(inserts.find((insert) => insert.bytes > 5 * 1024 * 1024)).toMatchObject({ table: "patches", rows: 1 });
    expect(inserts.filter((insert) => insert.table === "review_snapshots").length).toBeGreaterThan(1);

    const pg = connection(schema);
    expect(await rows(pg, tables)).toEqual(await rows(sqliteSql(db), tables));
    // Each identity gives the next id SQLite's AUTOINCREMENT would have given.
    const given = {
      agent_comment_changes: await pg.get<{ id: number }>(`INSERT INTO agent_comment_changes (target_key, file, line, side, kind, body, at) VALUES ('k', 'f', 1, 'RIGHT', 'removed', 'b', 1) RETURNING id`),
      agent_comment_outcomes: await pg.get<{ id: number }>(`INSERT INTO agent_comment_outcomes (repo, file, outcome, body, at) VALUES ('r', 'f', 'kept', 'b', 1) RETURNING id`),
      agent_messages: await pg.get<{ id: number }>(`INSERT INTO agent_messages (target_key, role, text, created_at) VALUES ('k', 'user', 't', 1) RETURNING id`),
      discussion_entries: await pg.get<{ id: number }>(`INSERT INTO discussion_entries (target_key, file, line, side, author, kind, body, created_at) VALUES ('k', 'f', 1, 'RIGHT', 'you', 'comment', 'b', 1) RETURNING id`),
    };
    expect(Object.fromEntries(Object.entries(given).map(([table, row]) => [table, row!.id]))).toEqual(NEXT_IDS);
    // plugin_updates stays SQLite's alone, and SQLite is as it was.
    expect(await pg.get(`SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = 'plugin_updates'`, [schema])).toBeUndefined();
    expect(tableChecksums(db)).toEqual(before);
    expect(db.inTransaction).toBe(false);

    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBe("postgres");
    expect((await run(harness, "status")).stdout).toBe([
      "storageBackend: postgres", "storage:owner: postgres", "state: maintenance; only bb review storage answers",
      "problem: The reviews are in Postgres now: reload the plugin to serve them from it (bb plugin reload code-review-workspace).",
    ].join("\n"));
    expect(await run(harness, "migrate")).toEqual({ exitCode: 1, stdout: "", stderr: "The reviews are in Postgres already (storage:owner)." });
  });

  // bug bash D1: a NUL character, which SQLite kept before 1.4.1, stopped migrate until it was fixed by hand.
  test("migrate copies a NUL character as U+FFFD, as the store keeps it now, and checks it as copied", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    const { db } = seed(bb);
    db.prepare(`UPDATE reviews SET title = 'a' || char(0) || 'b' WHERE target_key = 'B.ts'`).run();
    db.prepare(`UPDATE patches SET patch = patch || char(0) WHERE target_key = 'a.ts'`).run();
    await plugin(bb);
    expect(await run(harness, "migrate")).toMatchObject({ exitCode: 0, stderr: "" });
    const pg = connection(schema);
    expect(await pg.get(`SELECT title FROM reviews WHERE target_key = 'B.ts'`)).toEqual({ title: "a\uFFFDb" });
    expect((await pg.get<{ patch: string }>(`SELECT patch FROM patches WHERE target_key = 'a.ts'`))!.patch.endsWith("\uFFFD")).toBe(true);
    expect(await run(harness, "verify")).toMatchObject({ exitCode: 0 });
  });

  test("migrate reports every value Postgres can't take, and SQLite's migrations from a newer version, together, and copies nothing", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    const { db } = seed(bb);
    db.prepare(`UPDATE guides SET guide = CAST(x'c328' AS TEXT) WHERE target_key = 'a.ts'`).run();
    db.prepare(`UPDATE draft_comment_revisions SET line = 'one' WHERE target_key = 'a.ts'`).run();
    db.prepare(`UPDATE discussion_entries SET line = 2147483648`).run();
    db.prepare(`UPDATE file_views SET viewed_at = 9007199254740992 WHERE target_key = 'a.ts'`).run();
    await plugin(bb);
    const refused = await run(harness, "migrate");
    expect(refused).toEqual({ exitCode: 1, stdout: `Copying the reviews from SQLite's data.db to Postgres schema "${schema}".`, stderr: [
      "Nothing was copied:",
      "  - discussion_entries.line: 3 values are outside -2147483648 to 2147483647, which Postgres's integer column and the Store hold.",
      "  - draft_comment_revisions.line: 1 value isn't an integer, as the column is.",
      "  - file_views.viewed_at: 1 value is outside -9007199254740991 to 9007199254740991, which Postgres's bigint column and the Store hold.",
      "  - guides.guide: 1 value isn't valid UTF-8, which Postgres's text must be.",
    ].join("\n") });
    expect(await schemaExists(schema)).toBe(false);
    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBeUndefined();
    expect(db.inTransaction).toBe(false);

    db.prepare(`INSERT INTO _bb_migrations (id, applied_at, statement_hash) VALUES (38, 1, 'later')`).run();
    expect((await run(harness, "migrate")).stderr).toBe("Nothing was copied:\n  - SQLite's data.db has migration 38, which this version doesn't have: a newer version made it.");
    expect(await schemaExists(schema)).toBe(false);
  });

  test("migrate stopped before it commits, as a cancelled command or a reload stops it, leaves Postgres empty and SQLite owning the reviews", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    const { db } = seed(bb);
    await plugin(bb);
    // Cancelled once it has written every table.
    const cancel = new AbortController();
    const reviews = holdAt("reviews");
    const cancelled = harness.behavior.runCli(["storage", "migrate"], { signal: cancel.signal });
    await reviews.at;
    cancel.abort();
    reviews.release();
    expect(await cancelled).toMatchObject({ exitCode: 1, stderr: "Stopped before it finished, as the plugin is reloading or the command was cancelled. Nothing was changed." });
    expect(await schemaExists(schema)).toBe(false);
    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBeUndefined();
    expect(db.inTransaction).toBe(false);
    expect((await run(harness, "status")).stdout).toContain("storage:owner: sqlite");

    // Cancelled as it reads the last page it checks, once nothing is left to check but the COMMIT.
    const late = new AbortController();
    hooks.afterAll = (text) => { if (/^SELECT .* FROM "reviews" ORDER BY .* LIMIT \? OFFSET \?$/.test(text)) late.abort(); };
    expect(await harness.behavior.runCli(["storage", "migrate"], { signal: late.signal })).toMatchObject({ exitCode: 1, stderr: "Stopped before it finished, as the plugin is reloading or the command was cancelled. Nothing was changed." });
    hooks.afterAll = undefined;
    expect(await schemaExists(schema)).toBe(false);
    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBeUndefined();

    // A reload while it copies.
    const guides = holdAt("guides");
    const copying = run(harness, "migrate");
    await guides.at;
    const next = await harness.lifecycle.reload(plugin);
    guides.release();
    expect(await copying).toMatchObject({ exitCode: 1 });
    expect(await schemaExists(schema)).toBe(false);
    expect(await next.bb.storage.kv.get(STORAGE_OWNER_KEY)).toBeUndefined();
    // The new instance migrates from scratch.
    expect(await run(next.harness, "migrate")).toMatchObject({ exitCode: 0 });
    expect(await next.bb.storage.kv.get(STORAGE_OWNER_KEY)).toBe("postgres");
    await next.harness.lifecycle.dispose();
  });

  test("a copy that doesn't check out is rolled back, Postgres left empty and SQLite owning the reviews", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    seed(bb);
    await plugin(bb);
    // Postgres changes one value on its way in, as a faulty copy would.
    const pg = connection(schema);
    await migratePg(pg, schema);
    await pg.run(`CREATE FUNCTION retitle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.title := 'changed'; RETURN NEW; END $$`);
    await pg.run(`CREATE TRIGGER retitle BEFORE INSERT ON reviews FOR EACH ROW WHEN (NEW.target_key = 'a.ts') EXECUTE FUNCTION retitle()`);
    const { exitCode, stderr } = await run(harness, "migrate");
    expect({ exitCode, stderr }).toEqual({ exitCode: 1, stderr: "Nothing was copied:\n  - The copy differs in reviews: it was rolled back." });
    expect(await pgTablesWithRows(pg, sqliteTables(bb.storage.database()))).toEqual([]);
    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBeUndefined();
  });

  test("migrate from an install that never kept its reviews in SQLite makes SQLite's tables as SQLite storage would, and copies them, empty", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    await plugin(bb);
    expect(sqliteHasReviews(bb)).toBe(false);
    const { exitCode, stdout } = await run(harness, "migrate");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^Copied and checked, the same in SQLite and Postgres: 26 tables, 0 rows, and 4 next ids, in \d+ ms\.$/m);
    expect(sqliteHasReviews(bb)).toBe(true);
    expect(await connection(schema).get(`SELECT count(*) AS n FROM crw_migrations`)).toEqual({ n: 38 });
    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBe("postgres");
  });

  test("migrate and export-sqlite --replace-data-db give up, changing nothing, while another BB holds the writer lock", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    seed(bb);
    await plugin(bb);
    const holder = connection(schema);
    await holder.lockWriter();
    const held = `Another Code Review Workspace holds the writer lock on Postgres schema "${schema}" (waited 0.4 s). Stop the other BB using this schema, or give this one a schema of its own (postgresSchema). Nothing was changed.`;
    expect(await run(harness, "migrate")).toEqual({ exitCode: 1, stdout: "", stderr: held });
    expect(await schemaExists(schema)).toBe(false);
    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBeUndefined();

    await holder.end();
    expect(await run(harness, "migrate")).toMatchObject({ exitCode: 0 });
    await harness.behavior.setSettings({ storageBackend: "sqlite" });
    const next = await harness.lifecycle.reload(plugin);
    const again = connection(schema);
    await again.lockWriter();
    const before = tableChecksums(next.bb.storage.database());
    expect(await run(next.harness, "export-sqlite", "--replace-data-db")).toEqual({ exitCode: 1, stdout: "", stderr: held });
    expect(readdirSync(dirname(next.bb.storage.database().name)).filter((name) => /^data-(export|backup)-/.test(name))).toEqual([]);
    expect(tableChecksums(next.bb.storage.database())).toEqual(before);
    expect(await next.bb.storage.kv.get(STORAGE_OWNER_KEY)).toBe("postgres");
    await next.harness.lifecycle.dispose();
  });

  test("one storage command runs at a time", async () => {
    const { settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    seed(bb);
    await plugin(bb);
    const reviews = holdAt("reviews");
    const first = run(harness, "migrate");
    await reviews.at;
    expect(await run(harness, "verify")).toEqual({ exitCode: 1, stdout: "", stderr: "bb review storage migrate is running; try again once it's done." });
    reviews.release();
    expect(await first).toMatchObject({ exitCode: 0 });
  });

  test("a copy whose owner couldn't be marked is marked by migrate run again, without copying, only while Postgres holds exactly SQLite's reviews", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    const { db, tables } = seed(bb);
    await plugin(bb);
    const set = bb.storage.kv.set.bind(bb.storage.kv);
    vi.spyOn(bb.storage.kv, "set").mockImplementationOnce(() => Promise.reject(new Error("bb.db is locked")));
    const failed = await run(harness, "migrate");
    expect(failed).toMatchObject({ exitCode: 1, stderr: "Postgres holds the reviews, copied and checked, but storage:owner couldn't be set to postgres: bb.db is locked. Run the command again once BB answers." });
    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBeUndefined();
    vi.mocked(bb.storage.kv.set).mockImplementation(set);

    // One row changed in Postgres: refused, and nothing changes.
    const pg = connection(schema);
    await pg.run(`UPDATE reviews SET title = 'changed' WHERE target_key = 'a.ts'`);
    const inserts = watchInserts();
    expect(await run(harness, "migrate")).toEqual({ exitCode: 1, stdout: `Copying the reviews from SQLite's data.db to Postgres schema "${schema}".`, stderr: [
      "Nothing was copied:",
      `  - Postgres schema "${schema}" holds reviews already, in ${tables.map((table) => `${table} (${table === "review_preferences" ? 1 : table === "agent_messages" ? 0 : table === "patches" ? 4 : table === "review_snapshots" ? 6 : 3} row${table === "review_preferences" ? "" : "s"})`).filter((held) => !held.startsWith("agent_messages")).join(", ")}, and they differ from SQLite's in reviews. Drop its tables, or set postgresSchema to a new schema and reload (bb plugin reload code-review-workspace).`,
    ].join("\n") });
    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBeUndefined();
    expect((await pg.get<{ title: string }>(`SELECT title FROM reviews WHERE target_key = 'a.ts'`))!.title).toBe("changed");

    // Put back: marked, with nothing copied.
    await pg.run(`UPDATE reviews SET title = ? WHERE target_key = 'a.ts'`, [TEXTS[1]!]);
    const resumed = await run(harness, "migrate");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout).toContain(`Postgres already holds an identical, checked copy; only the owner was switched. The same in SQLite and Postgres: ${tables.length} tables,`);
    expect(inserts).toEqual([]);
    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBe("postgres");
    expect(await rows(pg, tables)).toEqual(await rows(sqliteSql(db), tables));
  });

  test("verify compares every table and next id, says which differ, and answers while the plugin serves", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    const { tables } = seed(bb);
    await plugin(bb);
    expect((await run(harness, "verify")).stderr).toBe(`Can't compare SQLite and Postgres:\n  - Postgres schema "${schema}" has none of the Store's tables: no reviews were copied there.`);
    expect(await run(harness, "migrate")).toMatchObject({ exitCode: 0 });
    const same = await run(harness, "verify");
    expect(same.exitCode).toBe(0);
    expect(same.stdout.split("\n").filter((line) => line.endsWith(" same"))).toHaveLength(tables.length + 4);
    expect(same.stdout).toMatch(/^ {2}discussion_entries next id +47 +47 {2}same$/m);
    expect(same.stdout).toMatch(new RegExp(`^The same in SQLite and Postgres: ${tables.length} tables, \\d+ rows, and 4 next ids, in \\d+ ms\\.$`, "m"));

    const pg = connection(schema);
    await pg.run(`UPDATE patches SET hash = 'other' WHERE target_key = 'huge'`);
    await pg.get(`SELECT setval(pg_get_serial_sequence('agent_messages', 'id'), 5)`);
    // Bytes that aren't UTF-8 in SQLite, which JavaScript reads as the U+FFFD Postgres has: the same text, not the same bytes.
    bb.storage.database().prepare(`UPDATE guides SET guide = CAST(x'ff' AS TEXT) WHERE target_key = 'a.ts'`).run();
    await pg.run(`UPDATE guides SET guide = ? WHERE target_key = 'a.ts'`, ["\uFFFD"]);
    const differ = await run(harness, "verify");
    expect(differ.exitCode).toBe(1);
    expect(differ.stdout).toMatch(/^ {2}patches +4 +4 {2}DIFFERENT$/m);
    expect(differ.stdout).toMatch(/^ {2}guides +3 +3 {2}DIFFERENT$/m);
    expect(differ.stdout).toMatch(/^ {2}agent_messages next id +1 +6 {2}DIFFERENT$/m);
    expect(differ.stdout.split("\n").at(-1)).toBe("Different in SQLite and Postgres: guides, patches, agent_messages's next id.");
    expect(differ.stderr).toBe("");
  });

  test("export-sqlite copies Postgres to a new file beside data.db, leaving data.db alone; with --replace-data-db it backs data.db up, replaces its reviews, and marks SQLite as holding them", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    const { db, tables } = seed(bb);
    const seeded = tableChecksums(db);
    await plugin(bb);
    expect(await run(harness, "migrate")).toMatchObject({ exitCode: 0 });
    // data.db's reviews replaced with others: only Postgres has the seeded ones.
    db.transaction(() => {
      for (const table of tables) db.prepare(`DELETE FROM "${table}"`).run();
      db.prepare(`UPDATE sqlite_sequence SET seq = 999`).run();
      db.prepare(`INSERT INTO reviews (target_key, kind, status, created_at) VALUES ('stale', 'pr', 'tracked', 1)`).run();
    })();
    const stale = tableChecksums(db);
    await harness.behavior.setSettings({ storageBackend: "sqlite" });
    const next = await harness.lifecycle.reload(plugin);
    const nextDb = next.bb.storage.database();
    const dir = dirname(nextDb.name);

    const exported = await run(next.harness, "export-sqlite");
    expect(exported.stderr).toBe("");
    expect(exported.exitCode).toBe(0);
    const file = /^The copy: (.+)$/m.exec(exported.stdout)![1]!;
    expect(file).toMatch(new RegExp(`^${dir}/data-export-\\d{8}T\\d{6}Z(-\\d+)?\\.db$`));
    expect(exported.stdout.split("\n")[0]).toBe(`Copying the reviews from Postgres schema "${schema}" to ${file}.`);
    expect(exported.stdout).toMatch(new RegExp(`^Exported and checked, the same in Postgres and the copy: ${tables.length} tables, \\d+ rows, and 4 next ids, in \\d+ ms\\.$`, "m"));
    expect(tableChecksums(nextDb)).toEqual(stale);
    expect(await next.bb.storage.kv.get(STORAGE_OWNER_KEY)).toBe("postgres");
    const copy = new Database(file, { readonly: true });
    // The copy is data.db's, its own tables included, with Postgres's reviews: each table's rows, their types, and
    // sqlite_sequence as seeded, where AUTOINCREMENT's record of agent_comment_changes, missing, is now its last id.
    const copied = tableChecksums(copy);
    expect({ ...copied, sqlite_sequence: undefined }).toEqual({ ...seeded, sqlite_sequence: undefined });
    expect(copy.prepare(`SELECT name, seq, typeof(seq) AS type FROM sqlite_sequence ORDER BY name`).all()).toEqual([
      { name: "agent_comment_changes", seq: 12, type: "integer" }, { name: "agent_comment_outcomes", seq: 12, type: "integer" },
      { name: "agent_messages", seq: 0, type: "integer" }, { name: "discussion_entries", seq: 46, type: "integer" },
    ]);
    expect(copy.prepare("PRAGMA integrity_check").pluck().get()).toBe("ok");
    copy.close();

    const replaced = await run(next.harness, "export-sqlite", "--replace-data-db");
    expect(replaced.stderr).toBe("");
    expect(replaced.exitCode).toBe(0);
    const backup = /^Backed data\.db up to (.+)\.$/m.exec(replaced.stdout)![1]!;
    expect(backup).toMatch(new RegExp(`^${dir}/data-backup-\\d{8}T\\d{6}Z(-\\d+)?\\.db$`));
    expect(replaced.stdout).toContain("Replaced data.db's reviews with the copy, and checked them.\nstorage:owner is sqlite now. Reload the plugin to serve the reviews from SQLite: bb plugin reload code-review-workspace");
    const backedUp = new Database(backup, { readonly: true });
    expect(tableChecksums(backedUp)).toEqual(stale);
    backedUp.close();
    expect(tableChecksums(nextDb)).toEqual(copied);
    expect(nextDb.prepare(`SELECT automatic, next_attempt FROM plugin_updates`).get()).toEqual({ automatic: 1, next_attempt: 42 });
    expect(await next.bb.storage.kv.get(STORAGE_OWNER_KEY)).toBe("sqlite");
    expect((await run(next.harness, "status")).stdout).toContain("storage:owner: sqlite\nstate: maintenance; only bb review storage answers\nproblem: The reviews are in SQLite now: reload the plugin to serve them from it (bb plugin reload code-review-workspace).");
    expect(await run(next.harness, "verify")).toMatchObject({ exitCode: 0 });
    expect(await run(next.harness, "export-sqlite")).toEqual({ exitCode: 1, stdout: "", stderr: "The reviews are in SQLite already (storage:owner)." });
    await next.harness.lifecycle.dispose();
  });

  test("an export that doesn't check out is removed, data.db left as it was", async () => {
    const { settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    const { db } = seed(bb);
    // The copy is data.db's, its trigger too, which changes one value on its way in, as a faulty copy would.
    db.exec(`CREATE TRIGGER retitle AFTER INSERT ON reviews WHEN NEW.target_key = 'a.ts' BEGIN UPDATE reviews SET title = 'changed' WHERE target_key = NEW.target_key; END`);
    await plugin(bb);
    expect(await run(harness, "migrate")).toMatchObject({ exitCode: 0 });
    await harness.behavior.setSettings({ storageBackend: "sqlite" });
    const next = await harness.lifecycle.reload(plugin);
    const before = tableChecksums(next.bb.storage.database());
    const { exitCode, stderr } = await run(next.harness, "export-sqlite", "--replace-data-db");
    expect({ exitCode, stderr }).toEqual({ exitCode: 1, stderr: "Nothing was exported:\n  - The copy differs in reviews: it was rolled back." });
    expect(readdirSync(dirname(next.bb.storage.database().name)).filter((name) => /^data-(export|backup)-/.test(name))).toEqual([]);
    expect(tableChecksums(next.bb.storage.database())).toEqual(before);
    expect(await next.bb.storage.kv.get(STORAGE_OWNER_KEY)).toBe("postgres");
    await next.harness.lifecycle.dispose();
  });

  test("export-sqlite stopped before it finishes leaves no copy and data.db as it was, and one never takes another's name", async () => {
    const { settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    seed(bb);
    await plugin(bb);
    expect(await run(harness, "migrate")).toMatchObject({ exitCode: 0 });
    await harness.behavior.setSettings({ storageBackend: "sqlite" });
    const next = await harness.lifecycle.reload(plugin);
    const db = next.bb.storage.database();
    const dir = dirname(db.name);
    const before = tableChecksums(db);
    const files = () => readdirSync(dir).filter((name) => /^data-(export|backup)-/.test(name));

    // Stopped once data.db is backed up, while it checks data.db's replaced reviews, which it then rolls back.
    const cancel = new AbortController();
    vi.spyOn(next.bb.log, "info").mockImplementation((message: string) => { if (message.startsWith("bb review storage export-sqlite: Backed data.db up to ")) cancel.abort(); });
    expect(await next.harness.behavior.runCli(["storage", "export-sqlite", "--replace-data-db"], { signal: cancel.signal })).toMatchObject({
      exitCode: 1, stderr: "Stopped before it finished, as the plugin is reloading or the command was cancelled. Nothing was changed.",
    });
    expect(files()).toEqual([]);
    expect(tableChecksums(db)).toEqual(before);
    expect(await next.bb.storage.kv.get(STORAGE_OWNER_KEY)).toBe("postgres");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T01:34:41.500Z"));
    writeFileSync(join(dir, "data-export-20261021T013441Z.db"), "");
    writeFileSync(join(dir, "data-backup-20261021T013441Z-2.db"), "");
    const numbered = await run(next.harness, "export-sqlite");
    expect(numbered).toMatchObject({ exitCode: 0, stdout: expect.stringContaining(`\nThe copy: ${join(dir, "data-export-20261021T013441Z-3.db")}`) });
    expect(files().sort()).toEqual(["data-backup-20261021T013441Z-2.db", "data-export-20261021T013441Z-3.db", "data-export-20261021T013441Z.db"]);
    await next.harness.lifecycle.dispose();
  });

  test("the plugin's own reviews go to Postgres, are served from there after a reload, and come back to SQLite, served from there after another", async () => {
    const { settings } = postgresSettings();
    const { bb, harness } = await host({ storageBackend: "sqlite" });
    await plugin(bb);
    const { preferences, revision } = await harness.behavior.callRpc("getPreferences", null) as { preferences: object; revision: number };
    await harness.behavior.callRpc("savePreferences", { preferences: { ...preferences, assistantInstructions: "Kept across both moves." }, revision });
    const store = queueStore(createStore(bb));
    await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, projectId: "p1", title: "Moved" });
    await store.dispose();
    await harness.behavior.callRpc("saveReviewerNotes", { targetKey: "pr-1", body: "Notes kept across both moves.", revision: 0 });
    const moved = async (served: FakePluginHarness) => {
      expect(await served.callRpc("getPreferences", null)).toMatchObject({ preferences: { assistantInstructions: "Kept across both moves." } });
      expect(await served.callRpc("getReviewerNotes", { targetKey: "pr-1" })).toMatchObject({ body: "Notes kept across both moves." });
    };
    await harness.behavior.setSettings(settings);

    let current = await harness.lifecycle.reload(plugin);
    expect(await run(current.harness, "migrate")).toMatchObject({ exitCode: 0 });
    current = await current.harness.lifecycle.reload(plugin);
    current.harness.behavior.runService("storage");
    await vi.waitFor(() => { expect((current.harness.inspection.registrations.rpcMethods ?? []).length).toBeGreaterThan(10); }, { timeout: 15_000, interval: 50 });
    await moved(current.harness);
    // verify answers while the plugin serves, saying which side may have moved on.
    const serving = await run(current.harness, "verify");
    expect(serving).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("The plugin serves the reviews from Postgres, so they may have changed since the other was copied.") });

    await current.harness.behavior.setSettings({ storageBackend: "sqlite" });
    current = await current.harness.lifecycle.reload(plugin);
    expect(await run(current.harness, "export-sqlite", "--replace-data-db")).toMatchObject({ exitCode: 0 });
    current = await current.harness.lifecycle.reload(plugin);
    expect(current.harness.inspection.needsConfigurationMessages).toEqual([]);
    await moved(current.harness);
    await current.harness.lifecycle.dispose();
  });
});
