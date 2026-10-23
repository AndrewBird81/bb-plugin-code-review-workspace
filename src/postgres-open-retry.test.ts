// Activation's open of Postgres storage, tried again after a try that failed part way. bug bash F4: interruptGenerations
// commits, a later statement of the same open fails (here a statement_timeout on a locked table, as any Postgres error
// would), and openPostgres tries the whole open again, which found no review generating: the guide writers the reload
// interrupted were never stopped or archived, and their guides never restarted.
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("./db/pg", async (original) => {
  const actual = await original<typeof import("./db/pg")>();
  // A statement waits 1.5 s for a lock rather than 30, so the test is quick; nothing else changes.
  return { ...actual, pgSql: (options: import("./db/pg").PgOptions) => actual.pgSql({ ...options, timeouts: { statementMs: 1_500, queryMs: 5_000, writerLockMs: 400, ...options.timeouts } }) };
});
const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n";
vi.mock("./gh", async (original) => ({
  ...await original<typeof import("./gh")>(),
  runGh: vi.fn(async () => ({ code: 1, stdout: "", stderr: "offline" })),
  runGit: vi.fn(async () => ({ code: 0, stdout: PATCH, stderr: "" })),
}));

import plugin from "../server";
import { pgSql, type PgSql } from "./db/pg";
import { migratePg } from "./db/pg-migrations";
import { testPgOptions, testPgUrl } from "./db/pg-test.test-support";
import { storeOn } from "./store";
import { host, opened, postgresSettings } from "./pg-faults.test-support";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {}); });

/** A review whose rebuild a reload interrupted, its writer recorded, with a running ask on its summary. */
async function interruptedReview(schema: string) {
  const seeding = pgSql(testPgOptions(schema));
  cleanup.push(async () => {
    const admin = pgSql(testPgOptions("public"));
    await admin.run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  cleanup.push(() => seeding.end());
  await migratePg(seeding, schema);
  const seed = storeOn(seeding);
  await seed.saveReview({ targetKey: "local:feature", kind: "ref", gitRef: "main...feature", cwd: process.cwd(), status: "generating", createdAt: 1, projectId: "p1" });
  await seed.savePatch("local:feature", PATCH);
  const generation = await seed.beginGeneration("local:feature");
  await seed.setGenerationWorker("local:feature", generation, "old-writer");
  await seed.setLifecycle("local:feature", { summaryAsk: { threadId: "assistant", state: "running", at: Date.now() } });
  return { seeding, seed };
}

function sdkWith(spawned: () => void) {
  return { threads: {
    spawn: async () => { spawned(); return { id: "new-writer" }; },
    wait: () => new Promise(() => {}),
    archive: vi.fn(async () => ({})), stop: vi.fn(async () => ({})),
    list: async () => ({ threads: [], nextCursor: null }),
    queuedMessages: { list: async () => [] },
  }, projects: { defaultExecutionOptions: async () => null }, providers: { list: async () => [] } };
}

describe.skipIf(!testPgUrl)("activation's open of Postgres storage, tried again after a partial open", () => {
  test("control: opened in one try, the interrupted writer is stopped and archived and the guide restarts", async () => {
    const { schema, settings } = postgresSettings();
    await interruptedReview(schema);
    const spawned = vi.fn();
    const sdk = sdkWith(spawned);
    const { bb, harness } = await host(settings, sdk);
    cleanup.push(() => harness.lifecycle.dispose());
    await plugin(bb);
    harness.behavior.runService("storage");
    await opened(harness);
    await vi.waitFor(() => { expect(spawned).toHaveBeenCalledTimes(1); }, { timeout: 5_000 });
    expect(sdk.threads.stop).toHaveBeenCalledWith({ threadId: "old-writer" });
    expect(sdk.threads.archive).toHaveBeenCalledWith({ threadId: "old-writer" });
  }, 30_000);

  test("a failure after interruptGenerations committed: the next try still stops and archives the interrupted writer, and the guide restarts", async () => {
    const { schema, settings } = postgresSettings();
    await interruptedReview(schema);
    // An operator's session (or a long migration, vacuum full, …) holds review_lifecycle against writes for a moment:
    // the open's clearAsks waits on it past statement_timeout, after interruptGenerations has committed.
    const locker: PgSql = pgSql(testPgOptions(schema));
    cleanup.push(() => locker.end());
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => {
      void locker.transaction(async () => {
        await locker.run("LOCK TABLE review_lifecycle IN EXCLUSIVE MODE");
        resolve();
        await held;
      });
    });
    await locked;
    const spawned = vi.fn();
    const sdk = sdkWith(spawned);
    const { bb, harness } = await host(settings, sdk);
    cleanup.push(() => harness.lifecycle.dispose());
    await plugin(bb);
    harness.behavior.runService("storage");
    await vi.waitFor(() => {
      expect(harness.inspection.logEntries.map((entry) => entry.message)).toContainEqual(expect.stringMatching(/^Could not open Code Review Workspace's Postgres storage: Postgres answered: canceling statement due to statement timeout/));
    }, { timeout: 10_000, interval: 50 });
    // bug bash F7: a statement timeout passes; it isn't a setting to fix.
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
    release();
    await opened(harness);
    await vi.waitFor(() => { expect(spawned).toHaveBeenCalledTimes(1); }, { timeout: 5_000 });
    expect(sdk.threads.stop).toHaveBeenCalledWith({ threadId: "old-writer" });
    expect(sdk.threads.archive).toHaveBeenCalledWith({ threadId: "old-writer" });
  }, 30_000);
});
