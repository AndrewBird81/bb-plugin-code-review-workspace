// For tests, not the plugin: the Postgres the backend tests run the Store on when CRW_TEST_PG_URL is set
// (postgres://user:password@host:port/database, as scripts/test-postgres.sh prints it). Each fake host's database gets
// a schema of its own, migrated by its first statement, which dropPgTestSchemas drops once its test is done.
import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { pgSql, type PgOptions, type PgSql } from "./pg";
import { migratePg } from "./pg-migrations";
import type { Sql, SqlValue } from "./sql";

export const testPgUrl = process.env.CRW_TEST_PG_URL || undefined;

interface TestSchema { schema: string; pg: PgSql; sql: Sql }

// By the fake host's data.db path, which a reloaded host keeps, so its store finds what the one before it wrote.
const schemas = new Map<string, TestSchema>();

/** pgSql's options for CRW_TEST_PG_URL, which carries its password: postgresUrl doesn't. */
export function testPgOptions(schema: string): PgOptions {
  if (!testPgUrl) throw new Error("CRW_TEST_PG_URL is not set");
  const url = new URL(testPgUrl);
  const password = decodeURIComponent(url.password);
  url.password = "";
  return { url: url.href, password, schema, ssl: "require", applicationName: "code-review-workspace tests" };
}

/** A schema name no other test uses. */
export const testSchemaName = () => `crw_test_${randomBytes(6).toString("hex")}`;

/** The Sql over the schema of `bb`'s database, migrated before its first statement runs. */
export function pgTestSql(bb: BbPluginApi): Sql {
  const path = bb.storage.database().name;
  let entry = schemas.get(path);
  if (!entry) {
    const schema = testSchemaName();
    const pg = pgSql(testPgOptions(schema));
    entry = { schema, pg, sql: afterMigrating(pg, schema) };
    schemas.set(path, entry);
  }
  return entry.sql;
}

/** Close the connection of `bb`'s schema, as the host closes its SQLite database; dropPgTestSchemas still drops it. */
export async function endPgTestSql(bb: BbPluginApi): Promise<void> {
  await schemas.get(bb.storage.database().name)?.pg.end();
}

/** `pg`, with migratePg run once before the first call. */
function afterMigrating(pg: PgSql, schema: string): Sql {
  let migrated: Promise<void> | null = null;
  let done = false;
  const ready = async () => {
    if (done) return;
    await (migrated ??= migratePg(pg, schema).then(() => { done = true; }));
  };
  return {
    dialect: "postgres",
    async all<T>(text: string, params?: readonly SqlValue[]) { await ready(); return pg.all<T>(text, params); },
    async get<T>(text: string, params?: readonly SqlValue[]) { await ready(); return pg.get<T>(text, params); },
    async run(text: string, params?: readonly SqlValue[]) { await ready(); return pg.run(text, params); },
    async transaction<T>(fn: () => Promise<T>) { await ready(); return pg.transaction(fn); },
  };
}

/** Close every test schema's connection and drop the schemas, on a connection of its own. */
export async function dropPgTestSchemas(): Promise<void> {
  const ended = [...schemas.values()];
  schemas.clear();
  if (!ended.length) return;
  await Promise.all(ended.map((entry) => entry.pg.end()));
  const admin = pgSql(testPgOptions("public"));
  try {
    for (const { schema } of ended) await admin.run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
}
