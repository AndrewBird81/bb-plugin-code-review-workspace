import { randomBytes } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createStore } from "../store";
import { pgSql, type PgSql } from "./pg";
import { migratePg, PG_MIGRATIONS } from "./pg-migrations";

/** The statements createStore hands bb.storage.migrate. */
function sqliteMigrations(): string[] {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const migrate = vi.spyOn(bb.storage, "migrate");
  createStore(bb);
  return migrate.mock.calls[0]![1];
}

/** The table, and column or index, a migration makes. */
function change(statement: string) {
  const made = /^(CREATE TABLE IF NOT EXISTS (\w+)|ALTER TABLE (\w+) ADD COLUMN (\w+)|CREATE INDEX IF NOT EXISTS (\w+) ON (\w+))/.exec(statement);
  return made?.[1]?.replace(/\s+/g, " ");
}

test("each Postgres migration makes the change the SQLite migration at its index makes", () => {
  const sqlite = sqliteMigrations();
  expect(PG_MIGRATIONS).toHaveLength(38);
  expect(PG_MIGRATIONS.map(change)).toEqual(sqlite.map(change));
  expect(PG_MIGRATIONS.map(change)).not.toContain(undefined);
});

interface ColumnShape { name: string; type: string; nullable: boolean; default: string | null; identity: boolean }
interface TableShape { columns: ColumnShape[]; primaryKey: string[]; indexes: Array<{ name: string; unique: boolean; columns: string[] }> }

/**
 * The tables in SQLite. A primary key's columns count as NOT NULL, as Postgres makes them: SQLite lets a NULL into a
 * text one, which the Store never writes. AUTOINCREMENT is an identity.
 */
function sqliteShape(db: Database.Database): Record<string, TableShape> {
  const tables = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string; sql: string }>;
  return Object.fromEntries(tables.map(({ name, sql }) => {
    const info = db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid`).all(name) as
      Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
    const indexes = (db.prepare(`SELECT name, "unique" FROM pragma_index_list(?) WHERE origin='c' ORDER BY name`).all(name) as Array<{ name: string; unique: number }>)
      .map((index) => ({
        name: index.name,
        unique: !!index.unique,
        columns: (db.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`).all(index.name) as Array<{ name: string }>).map((column) => column.name),
      }));
    return [name, {
      columns: info.map((column) => ({
        name: column.name,
        type: column.type.toLowerCase(),
        nullable: !column.notnull && !column.pk,
        default: column.dflt_value,
        identity: column.pk === 1 && column.type === "INTEGER" && /\bAUTOINCREMENT\b/i.test(sql),
      })),
      primaryKey: info.filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name),
      indexes,
    }];
  }));
}

const testUrl = process.env.CRW_TEST_PG_URL;

// Postgres from CRW_TEST_PG_URL (postgres://user:password@host:port/database), which scripts/test-postgres.sh starts.
describe.skipIf(!testUrl)("against Postgres (CRW_TEST_PG_URL)", () => {
  const parsed = new URL(testUrl ?? "postgres://unset@localhost/unset");
  const server = {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)),
  };
  const admin = new pg.Client({ ...server, ssl: { rejectUnauthorized: false } });
  const opened: PgSql[] = [];
  const schemas: string[] = [];
  const roles: string[] = [];

  beforeAll(async () => {
    await admin.connect();
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((sql) => sql.end()));
    for (const schema of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of roles.splice(0)) await admin.query(`DROP ROLE ${role}`);
  });

  afterAll(async () => {
    await admin.end();
  });

  /** A schema name, for migratePg to create. */
  function newSchema() {
    const schema = `crw_p8_${randomBytes(6).toString("hex")}`;
    schemas.push(schema);
    return schema;
  }

  function connect(schema: string, user = server.user, password = server.password) {
    const sql = pgSql({ url: `postgres://${user}@${server.host}:${server.port}/${server.database}`, password, schema, ssl: "require" });
    opened.push(sql);
    return sql;
  }

  /** The tables in Postgres, apart from crw_migrations, with each column's type as SQLite's affinity. */
  async function pgShape(schema: string): Promise<Record<string, TableShape>> {
    const { rows: columns } = await admin.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_identity: string }>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity FROM information_schema.columns
       WHERE table_schema=$1 AND table_name <> 'crw_migrations' ORDER BY table_name, ordinal_position`, [schema]);
    const { rows: keys } = await admin.query<{ table_name: string; column_name: string }>(
      `SELECT k.table_name, k.column_name FROM information_schema.table_constraints c
       JOIN information_schema.key_column_usage k ON k.constraint_schema=c.constraint_schema AND k.constraint_name=c.constraint_name AND k.table_name=c.table_name
       WHERE c.table_schema=$1 AND c.constraint_type='PRIMARY KEY' AND c.table_name <> 'crw_migrations' ORDER BY k.table_name, k.ordinal_position`, [schema]);
    const { rows: indexes } = await admin.query<{ table_name: string; name: string; unique: boolean; columns: string[] }>(
      `SELECT t.relname AS table_name, c.relname AS name, i.indisunique AS unique,
         array(SELECT a.attname FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n)
           JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum ORDER BY k.n)::text[] AS columns
       FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
       WHERE n.nspname=$1 AND NOT i.indisprimary AND t.relname <> 'crw_migrations' ORDER BY c.relname`, [schema]);
    const shape: Record<string, TableShape> = {};
    for (const column of columns) {
      (shape[column.table_name] ??= { columns: [], primaryKey: [], indexes: [] }).columns.push({
        name: column.column_name,
        type: ["smallint", "integer", "bigint"].includes(column.data_type) ? "integer" : column.data_type,
        nullable: column.is_nullable === "YES",
        // A literal default comes back with its cast, as in '0'::smallint; a number's comes back bare.
        default: column.column_default?.replace(/::[a-z ]+$/, "") ?? null,
        identity: column.is_identity === "YES",
      });
    }
    for (const key of keys) shape[key.table_name]!.primaryKey.push(key.column_name);
    for (const { table_name, ...index } of indexes) shape[table_name]!.indexes.push(index);
    return Object.fromEntries(Object.entries(shape).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  const recorded = async (schema: string) =>
    (await admin.query<{ id: number; statement_hash: string; applied_at: string }>(`SELECT id, statement_hash, applied_at FROM ${schema}.crw_migrations ORDER BY id`)).rows;
  const schemaExists = async (schema: string) => (await admin.query(`SELECT 1 FROM pg_namespace WHERE nspname=$1`, [schema])).rowCount === 1;

  test("after each migration, every table's columns, in order, nullability, defaults, primary key and indexes match SQLite's", async () => {
    const sqlite = sqliteMigrations();
    const db = new Database(":memory:");
    const schema = newSchema();
    const sql = connect(schema);
    try {
      for (const [index, statement] of sqlite.entries()) {
        db.exec(statement);
        await migratePg(sql, schema, PG_MIGRATIONS.slice(0, index + 1));
        expect(await pgShape(schema), `after migration ${index}`).toEqual(sqliteShape(db));
      }
    } finally {
      db.close();
    }
    expect((await recorded(schema)).map((row) => row.id)).toEqual([...PG_MIGRATIONS.keys()]);
  });

  test("timestamps, counters and ids are BIGINT, lines and PR numbers INTEGER, the flag SMALLINT, and only key text columns COLLATE \"C\"", async () => {
    const schema = newSchema();
    await migratePg(connect(schema), schema);
    const { rows: columns } = await admin.query<{ table_name: string; column_name: string; data_type: string; collation_name: string | null }>(
      `SELECT table_name, column_name, data_type, collation_name FROM information_schema.columns
       WHERE table_schema=$1 AND table_name <> 'crw_migrations' ORDER BY table_name, ordinal_position`, [schema]);
    const shape = await pgShape(schema);
    for (const { table_name: table, column_name: column, data_type: type, collation_name: collation } of columns) {
      const where = `${table}.${column}`;
      const key = column === "target_key" || shape[table]!.primaryKey.includes(column) || shape[table]!.indexes.some((index) => index.columns.includes(column));
      if (type === "text") expect(collation, where).toBe(key ? "C" : null);
      else if (column === "recorded") expect(type, where).toBe("smallint");
      else if (["line", "start_line", "number"].includes(column) || where === "review_preferences.id") expect(type, where).toBe("integer");
      else expect(type, where).toBe("bigint");
    }
    expect(columns.filter((column) => column.data_type === "bigint").map((column) => column.column_name)).toEqual(expect.arrayContaining(
      ["created_at", "viewed_at", "at", "fetched_at", "pr_updated_at", "resolved_seen_at", "assessed_at", "updated_at", "ignored_at", "revision", "id"]));
  });

  test("a shipped statement that changed, or another statement at an applied index, applies nothing and says to append instead", async () => {
    const schema = newSchema();
    await migratePg(connect(schema), schema);
    const before = await recorded(schema);
    const tampered = PG_MIGRATIONS.map((statement, id) => (id === 3 ? statement.replace("comments TEXT NOT NULL", "comments TEXT") : statement));
    await expect(migratePg(connect(schema), schema, [...tampered, `CREATE TABLE extra (id INTEGER)`])).rejects.toThrow(
      "Postgres migration 3 does not match the statement it recorded; append a new migration instead of changing or reusing an index");
    // Only whitespace.
    const spaced = PG_MIGRATIONS.map((statement, id) => (id === 0 ? `${statement} ` : statement));
    await expect(migratePg(connect(schema), schema, spaced)).rejects.toThrow("Postgres migration 0 does not match");
    await migratePg(connect(schema), schema, [...PG_MIGRATIONS, `CREATE TABLE extra_a (id INTEGER)`]);
    await expect(migratePg(connect(schema), schema, [...PG_MIGRATIONS, `CREATE TABLE extra_b (id INTEGER)`])).rejects.toThrow(
      `Postgres migration ${PG_MIGRATIONS.length} does not match`);
    expect(await recorded(schema)).toEqual([...before, expect.objectContaining({ id: PG_MIGRATIONS.length })]);
    expect((await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'extra%' ORDER BY table_name`, [schema])).rows)
      .toEqual([{ table_name: "extra_a" }]);
  });

  test("applied statements aren't run again, and one appended is applied alone", async () => {
    const schema = newSchema();
    const sql = connect(schema);
    await migratePg(sql, schema);
    const before = await recorded(schema);
    await migratePg(sql, schema);
    expect(await recorded(schema)).toEqual(before);
    await migratePg(sql, schema, [...PG_MIGRATIONS, `ALTER TABLE reviews ADD COLUMN later TEXT`]);
    const after = await recorded(schema);
    expect(after.slice(0, PG_MIGRATIONS.length)).toEqual(before);
    expect(after).toHaveLength(PG_MIGRATIONS.length + 1);
  });

  test("instances starting together apply each statement once", async () => {
    const schema = newSchema();
    const started = Array.from({ length: 4 }, () => migratePg(connect(schema), schema));
    await Promise.all(started);
    expect((await recorded(schema)).map((row) => row.id)).toEqual([...PG_MIGRATIONS.keys()]);
  });

  test("a statement that fails rolls back the whole run, the schema with it, and the connection carries on", async () => {
    const schema = newSchema();
    const sql = connect(schema);
    await expect(migratePg(sql, schema, [`CREATE TABLE twice (id INTEGER)`, `CREATE TABLE twice (id INTEGER)`])).rejects.toMatchObject({ code: "42P07" });
    expect(await schemaExists(schema)).toBe(false);
    await migratePg(sql, schema);
    expect(await recorded(schema)).toHaveLength(PG_MIGRATIONS.length);
  });

  test("a role that can't create schemas migrates the schema made for it", async () => {
    const role = `crw_p8_${randomBytes(6).toString("hex")}`;
    const password = randomBytes(16).toString("hex");
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    roles.push(role);
    const schema = newSchema();
    await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${role}`);
    expect((await admin.query(`SELECT has_database_privilege($1, current_database(), 'CREATE') AS can`, [role])).rows).toEqual([{ can: false }]);
    await migratePg(connect(schema, role, password), schema);
    expect(await recorded(schema)).toHaveLength(PG_MIGRATIONS.length);
  });

  test("a schema whose name needs quoting is created and migrated as written", async () => {
    const schema = `crw_p8 "${randomBytes(4).toString("hex")}"`;
    const sql = connect(schema);
    try {
      await migratePg(sql, schema);
      expect(await schemaExists(schema)).toBe(true);
      expect(await sql.get(`SELECT count(*) AS n FROM crw_migrations`)).toEqual({ n: PG_MIGRATIONS.length });
    } finally {
      await sql.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
    }
  });
});
