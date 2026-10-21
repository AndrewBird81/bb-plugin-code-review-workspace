// For tests, not the plugin: a backend tests' setup file. With CRW_TEST_PG_URL set, createStore returns the Store over
// a Postgres schema for each fake host's database, so the plugin a test starts and the test's own testStore share it;
// each test's schemas are dropped once it ends. A test file that needs SQLite's own store unmocks ./store.
import { afterAll, afterEach, vi } from "vitest";
import { dropPgTestSchemas, pgTestSql, testPgUrl } from "./db/pg-test.test-support";

vi.mock("./store", async (original) => {
  const actual = await original<typeof import("./store")>();
  if (!testPgUrl) return actual;
  return { ...actual, createStore: (bb: Parameters<typeof actual.createStore>[0]) => actual.storeOn(pgTestSql(bb)) };
});

afterEach(dropPgTestSchemas);
afterAll(dropPgTestSchemas);
