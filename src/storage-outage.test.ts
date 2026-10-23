// What a storage failure leaves behind, as a Postgres outage does: BB tells each thread event once, and a guide run
// records its end once, so a store call that fails then would leave a review generating, a feedback check or discussion
// waiting, or an ask queued, until a reload. The review-state pass settles them while the plugin serves.
import { expect, test, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n";
vi.mock("./gh", async (original) => ({
  ...await original<typeof import("./gh")>(),
  runGh: vi.fn(async () => ({ code: 1, stdout: "", stderr: "offline" })),
  runGit: vi.fn(async () => ({ code: 0, stdout: PATCH, stderr: "" })),
}));

import plugin from "../server";
import { GUIDE_UNFINISHED } from "./generate";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { testSql, testStore } from "./test-store.test-support";

/** One review-state pass: the service's first, which runs at once. */
async function reviewStatePass(harness: FakePluginHarness, settled: () => Promise<void>) {
  const { controller, done } = harness.runService("review-state");
  try {
    await vi.waitFor(settled, { timeout: 5_000, interval: 50 });
  } finally {
    controller.abort();
    await done;
  }
}

// bug bash F5: the run's end, recorded once and its failure swallowed, left the review generating until a reload:
// Rebuild did nothing, Delete was refused, and no log said why.
test("a guide whose run ended as the storage failed is failed, saying why, by the next review-state pass, and Rebuild builds it again", async () => {
  let spawns = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: {
      spawn: async () => { spawns++; throw new Error("spawn failed"); },
      archive: async () => ({}), stop: async () => ({}), list: async () => ({ threads: [], nextCursor: null }),
    },
    projects: { defaultExecutionOptions: async () => null }, providers: { list: async () => [] },
  } as never });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "local:feature", kind: "ref", gitRef: "main...feature", cwd: process.cwd(), status: "ready", createdAt: 1, projectId: "p1" });
  await store.savePatch("local:feature", PATCH);
  // The run's end fails to record, as when Postgres goes away as the writer fails.
  const sql = testSql(bb);
  if (sql.dialect === "sqlite") {
    await sql.run(`CREATE TRIGGER refuse_end BEFORE UPDATE ON reviews WHEN NEW.status = 'error' BEGIN SELECT RAISE(ABORT, 'Connection terminated unexpectedly'); END`);
  } else {
    await sql.run(`CREATE FUNCTION refuse_end() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Connection terminated unexpectedly'; END $$`);
    await sql.run(`CREATE TRIGGER refuse_end BEFORE UPDATE ON reviews FOR EACH ROW WHEN (NEW.status = 'error') EXECUTE FUNCTION refuse_end()`);
  }
  expect(await harness.behavior.callRpc("rereview", { targetKey: "local:feature" })).toEqual({ ok: true });
  await vi.waitFor(() => expect(harness.inspection.logEntries).toContainEqual({ level: "warn", message: expect.stringContaining("Could not record the end of the guide run for local:feature") }));
  expect((await store.getReview("local:feature"))?.status).toBe("generating");
  await sql.run(sql.dialect === "sqlite" ? `DROP TRIGGER refuse_end` : `DROP TRIGGER refuse_end ON reviews`);

  await reviewStatePass(harness, async () => expect(await store.getReview("local:feature")).toMatchObject({ status: "error", guideError: { text: GUIDE_UNFINISHED } }));
  expect(harness.inspection.logEntries).toContainEqual({ level: "warn", message: "The guide for local:feature was left generating with no run to finish it; it failed." });
  expect(await harness.behavior.callRpc("rereview", { targetKey: "local:feature" })).toEqual({ ok: true });
  await vi.waitFor(() => expect(spawns).toBe(2));
});

test("a review-state pass leaves a guide that's still running be", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: {
      spawn: async () => ({ id: "writer" }), wait: () => new Promise(() => {}),
      archive: async () => ({}), stop: async () => ({}), list: async () => ({ threads: [], nextCursor: null }),
    },
    projects: { defaultExecutionOptions: async () => null }, providers: { list: async () => [] },
  } as never });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "local:feature", kind: "ref", gitRef: "main...feature", cwd: process.cwd(), status: "ready", createdAt: 1, projectId: "p1" });
  await store.savePatch("local:feature", PATCH);
  expect(await harness.behavior.callRpc("rereview", { targetKey: "local:feature" })).toEqual({ ok: true });
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
  const { controller, done } = harness.runService("review-state");
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await done;
  expect(await store.getReview("local:feature")).toMatchObject({ status: "generating", guideError: null });
});

// Review round 1, NIT 2: a reload or update while a guide ran logged that its end couldn't be recorded, though the
// storage closing then is expected, and the next instance ends the run.
test("a guide run a reload stops logs nothing about recording its end", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: {
      spawn: async () => ({ id: "writer" }),
      wait: ({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true })),
      archive: async () => ({}), stop: async () => ({}), list: async () => ({ threads: [], nextCursor: null }),
    },
    projects: { defaultExecutionOptions: async () => null }, providers: { list: async () => [] },
  } as never });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "local:feature", kind: "ref", gitRef: "main...feature", cwd: process.cwd(), status: "ready", createdAt: 1, projectId: "p1" });
  await store.savePatch("local:feature", PATCH);
  expect(await harness.behavior.callRpc("rereview", { targetKey: "local:feature" })).toEqual({ ok: true });
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
  await harness.lifecycle.dispose();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(harness.inspection.logEntries.filter((entry) => entry.message.includes("Could not record the end of the guide run"))).toEqual([]);
});

const MINUTE = 60_000;

/** A served review whose assistant is `status` with nothing queued, after activation's own settling. */
async function assistantReview(status: "idle" | "active") {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    get: async () => makeThreadResponse({ id: "assistant", status }),
    queuedMessages: { list: async () => [] },
  } } as never });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1", projectId: "p1" });
  await store.setAssistantThread("pr-1", "assistant");
  // Activation settles what it finds waiting, in the background; these come after it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { harness, store, sql: testSql(bb) };
}

// bug bash F3: the thread.idle that ends a feedback check and a discussion's wait, lost to a storage failure, left
// "Checking your feedback…" and the wait until a reload.
test("a feedback check and a discussion whose turn ended unheard stop waiting on the review-state pass after they've waited two minutes", async () => {
  const { harness, store, sql } = await assistantReview("idle");
  await store.setLifecycle("pr-1", { verifyingSince: Date.now() - 3 * MINUTE, verifyingHead: "sha1", verifyingMessageId: null });
  await store.addDiscussionMessage("pr-1", { file: "a.ts", line: 3, side: "RIGHT" }, "reviewer", "Why?");
  await sql.run(`UPDATE discussion_entries SET created_at = ?`, [Date.now() - 3 * MINUTE]);
  await reviewStatePass(harness, async () => {
    expect((await store.getReview("pr-1"))?.verifyingSince ?? null).toBeNull();
    expect((await store.listDiscussions("pr-1"))[0]?.waiting).toBe(false);
  });
});

test("a feedback check or discussion asked for under two minutes ago, or whose assistant is still answering, keeps waiting", async () => {
  for (const [status, ago] of [["idle", 0], ["active", 3 * MINUTE]] as const) {
    const { harness, store, sql } = await assistantReview(status);
    await store.setLifecycle("pr-1", { verifyingSince: Date.now() - ago, verifyingHead: "sha1", verifyingMessageId: null });
    await store.addDiscussionMessage("pr-1", { file: "a.ts", line: 3, side: "RIGHT" }, "reviewer", "Why?");
    await sql.run(`UPDATE discussion_entries SET created_at = ?`, [Date.now() - ago]);
    const { controller, done } = harness.runService("review-state");
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await done;
    expect((await store.getReview("pr-1"))?.verifyingSince).toEqual(expect.any(Number));
    expect((await store.listDiscussions("pr-1"))[0]?.waiting).toBe(true);
  }
});

// bug bash F3: a message.dispatched lost to a storage failure left the reviewer's ask queued for good.
test("an ask whose message left the queue unheard is withdrawn on the review-state pass once its turn has ended", async () => {
  const { harness, store } = await assistantReview("idle");
  await store.setLifecycle("pr-1", { summaryAsk: { threadId: "assistant", state: "queued", queuedMessageId: "m1", at: Date.now() - 3 * MINUTE } });
  await reviewStatePass(harness, async () => expect((await store.getReview("pr-1"))?.summaryAsk ?? null).toBeNull());
});

test("an ask whose turn is under way is kept by the review-state pass", async () => {
  const { harness, store } = await assistantReview("active");
  await store.setLifecycle("pr-1", { summaryAsk: { threadId: "assistant", state: "running", at: Date.now() - 3 * MINUTE } });
  const { controller, done } = harness.runService("review-state");
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await done;
  expect((await store.getReview("pr-1"))?.summaryAsk).toMatchObject({ state: "running" });
});
