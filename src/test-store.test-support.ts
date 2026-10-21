// For tests, not the plugin: the Store, and its tables, on the backend the backend tests run on. That is SQLite, the
// fake host's own database, unless CRW_TEST_PG_URL names a Postgres: then src/test-backend.test-support.ts has
// createStore, the plugin's included, return the Store over a schema of the host's own (src/db/pg-test.test-support.ts).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { pgTestSql, testPgUrl } from "./db/pg-test.test-support";
import { sqliteSql, type Sql } from "./db/sql";
import { createStore } from "./store";
import { queueStore, type QueuedStore } from "./store-queue";

/** Whether the backend tests run on Postgres. */
export const testOnPostgres = !!testPgUrl;

/** The store's queue over `bb`'s Store, on the test backend: the tables the plugin started on `bb` uses. */
export function testStore(bb: BbPluginApi): QueuedStore {
  return queueStore(createStore(bb));
}

/** The Sql the Store on `bb` runs its statements through, for a test's own reads and writes of its tables. */
export function testSql(bb: BbPluginApi): Sql {
  return testOnPostgres ? pgTestSql(bb) : sqliteSql(bb.storage.database());
}
