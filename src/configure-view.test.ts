// bb.agents.configure reads a view of the store the queue keeps up to date: after any turn, it answers as fresh reads
// of the store would, and during a block it still answers as before the block.
import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, storeOn, type ReviewMeta, type Store } from "./store";
import type { Sql } from "./db/sql";
import { testSql } from "./test-store.test-support";
import { createConfigureView } from "./configure-view";
import { queueStore, type AsyncStore } from "./store-queue";
import { defaultPreferences } from "./preferences";
import { rng, type Rng } from "./fuzz-gen.test-support";

const KEYS = ["pr-1", "pr-2", "ref-1"];
const ASSISTANTS = ["assistant-1", "assistant-2", "assistant-3"];

const patchOf = (renamed: boolean) => renamed
  ? "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n"
  : "diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ b/old.ts\n@@ -1 +1 @@\n-a\n+b\n";
const guideOf = (title: string) => ({ title, intent: "I", unplacedFiles: [], sections: [{ id: "s", title: "S", overview: "o", risk: "low", diffs: [{ file: "old.ts", summary: "s" }] }], hotspots: [] });

async function views() {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = createStore(bb);
  const view = await createConfigureView(bb, store);
  return { store, view, queued: queueStore(view.backend, { afterTurn: view.afterTurn }) };
}

/** What configure reads, from fresh reads of `store`, beside the view's answers. */
async function compare(store: Store, view: Awaited<ReturnType<typeof createConfigureView>>, workers: readonly string[]) {
  const assistants = await store.listAssistantThreads();
  const fresh = async (threadId: string) => {
    const assistant = assistants.find((thread) => thread.threadId === threadId)?.targetKey ?? null;
    const writer = await store.generationOf(threadId);
    return { role: assistant ? "assistant" : writer ? "writer" : null, review: assistant ?? writer ?? null };
  };
  const threads = [...ASSISTANTS, ...workers, "stranger"];
  const freshThreads = [];
  for (const id of threads) freshThreads.push({ id, ...await fresh(id) });
  const freshReviews = [];
  for (const key of KEYS) {
    const review = await store.getReview(key);
    freshReviews.push({ key, review, guide: review ? await store.getGuide(key) : null });
  }
  return {
    view: {
      preferences: view.preferences(),
      threads: threads.map((id) => ({ id, role: view.threadRole({ id, title: null }), review: view.threadReview({ id, title: null }) })),
      reviews: KEYS.map((key) => ({ key, review: view.review(key), guide: view.review(key) ? view.guide(key) : null })),
    },
    fresh: {
      preferences: (await store.getPreferences()).preferences,
      threads: freshThreads,
      reviews: freshReviews,
    },
  };
}

/** One random write through `tx`, a store or a block's: what configure reads, or something else beside it. */
async function randomWrite(r: Rng, tx: AsyncStore, made: { generations: Map<string, string>; workers: string[]; backedUp: string[] }): Promise<string> {
  const key = r.pick(KEYS);
  switch (r.int(0, 16)) {
    case 0: {
      const review: ReviewMeta = { targetKey: key, kind: key.startsWith("pr") ? "pr" : "ref", number: r.int(1, 9), status: r.pick(["ready", "generating", "error", "tracked"] as const), createdAt: r.int(1, 5), headSha: `sha${r.int(1, 3)}` };
      await tx.saveReview(review);
      return `saveReview ${key}`;
    }
    case 1: await tx.setStatus(key, r.pick(["ready", "generating", "error"] as const)); return `setStatus ${key}`;
    case 2: await tx.setLifecycle(key, r.pick([{ authorAssociation: "MEMBER" }, { authorAssociation: "NONE", approvedHead: "sha1" }, { userArchivedAt: r.int(1, 9) }, { name: `n${r.int(1, 3)}` }])); return `setLifecycle ${key}`;
    case 3: await tx.deleteReview(key); return `deleteReview ${key}`;
    case 4: await tx.savePatch(key, patchOf(r.bool())); return `savePatch ${key}`;
    case 5: await tx.dropPatch(key); return `dropPatch ${key}`;
    case 6: await tx.saveGuide(key, guideOf(`guide ${r.int(1, 9)}`) as never); return `saveGuide ${key}`;
    case 7: {
      // A rebuild keeps the guide it replaces, for restoreGuide.
      const kept = r.bool() && (await tx.backupGuide(key), made.backedUp.push(key), true);
      made.generations.set(key, await tx.beginGeneration(key));
      return `${kept ? "backupGuide, " : ""}beginGeneration ${key}`;
    }
    case 8: {
      // Each worker once, as spawned threads are.
      const worker = `writer-${made.workers.length + 1}`;
      made.workers.push(worker);
      await tx.setGenerationWorker(key, r.bool(0.8) ? made.generations.get(key) ?? "none" : "stale", worker);
      return `setGenerationWorker ${key} ${worker}`;
    }
    case 9: await tx.interruptGenerations(); return "interruptGenerations";
    case 10: await tx.backupGuide(key); made.backedUp.push(key); return `backupGuide ${key}`;
    case 11: {
      // Mostly a review that was backed up, so a guide comes back.
      const restoring = made.backedUp.length && r.bool(0.8) ? r.pick(made.backedUp) : key;
      await tx.restoreGuide(restoring);
      return `restoreGuide ${restoring}`;
    }
    case 12: await tx.setAssistantThread(key, r.pick(ASSISTANTS)); return `setAssistantThread ${key}`;
    case 13: await tx.clearAssistantThread(key); return `clearAssistantThread ${key}`;
    case 14: {
      const { preferences, revision } = await tx.getPreferences();
      await tx.savePreferences({ ...preferences, runRepoChecks: r.bool(), assistantInstructions: `be ${r.int(1, 9)}`, knobs: { ...preferences.knobs, reviewCommandInThreads: r.bool() } }, revision);
      return "savePreferences";
    }
    case 15: await tx.setReplyDraft(key, "t", "reply", "agent"); return `setReplyDraft ${key}`;
    default: await tx.ignoreDiscovery(key); return `ignoreDiscovery ${key}`;
  }
}

test.each([1, 2, 3, 4, 5])("after random writes, alone or in blocks, the configure view answers as fresh reads do (seed %i)", async (seed) => {
  const r = rng(seed);
  const { store, view, queued } = await views();
  const made = { generations: new Map<string, string>(), workers: [] as string[], backedUp: [] as string[] };
  await queued.savePreferences(defaultPreferences, 0);
  for (let step = 0; step < 150; step++) {
    let done: string;
    if (r.bool(0.25)) {
      done = await queued.exclusive(async (tx) => {
        const writes: string[] = [];
        for (let n = r.int(2, 4); n > 0; n--) writes.push(await randomWrite(r, tx, made));
        return `block: ${writes.join(", ")}`;
      });
    } else done = await randomWrite(r, queued, made);
    const { view: seen, fresh } = await compare(store, view, made.workers);
    expect({ step, done, ...seen }).toEqual({ step, done, ...fresh });
  }
});

test("during a block the view answers as before it, and from the turn after it as fresh reads do", async () => {
  const { view, queued } = await views();
  await queued.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  await queued.saveGuide("pr-1", guideOf("First") as never);
  const during: unknown[] = [];
  await queued.exclusive(async (tx) => {
    await tx.setAssistantThread("pr-1", "assistant-1");
    await tx.saveGuide("pr-1", guideOf("Second") as never);
    during.push(view.threadRole({ id: "assistant-1", title: null }), view.guide("pr-1")?.title);
  });
  expect(during).toEqual([null, "First"]);
  expect([view.threadRole({ id: "assistant-1", title: null }), view.guide("pr-1")?.title]).toEqual(["assistant", "Second"]);
});

test("a read that fails while the view catches up is logged, leaves the call's result, and is tried again after the next turn", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = createStore(bb);
  let failing = false;
  const backend = { ...store, listReviews: () => { if (failing) throw new Error("connection lost"); return store.listReviews(); } };
  const view = await createConfigureView(bb, backend);
  const queued = queueStore(view.backend, { afterTurn: view.afterTurn });
  failing = true;
  await expect(queued.setAssistantThread("pr-1", "assistant-1")).resolves.toBeUndefined();
  expect(view.threadRole({ id: "assistant-1", title: null })).toBeNull();
  expect(harness.inspection.logEntries.map((entry) => `${entry.level}: ${entry.message}`)).toContain("warn: Could not read what agents are configured with: Error: connection lost");
  failing = false;
  // A read is a turn too: the view catches up after it.
  await expect(queued.getAssistantThread("pr-1")).resolves.toBe("assistant-1");
  expect(view.threadRole({ id: "assistant-1", title: null })).toBe("assistant");
});

/** `sql`, counting the statements that read a whole patch. */
function countingPatchReads(sql: Sql) {
  const counts = { patchReads: 0 };
  const counted: Sql = {
    dialect: sql.dialect,
    all: (text, params) => sql.all(text, params),
    get: (text, params) => { if (text.startsWith("SELECT patch FROM patches")) counts.patchReads++; return sql.get(text, params); },
    run: (text, params) => sql.run(text, params),
    transaction: (fn) => sql.transaction(fn),
  };
  return { counted, counts };
}

// bug bash HC-3: any call naming a review, as each review-state poll's lifecycle writes do, had the view read its
// guide again, which reads its whole patch for renames whenever more than 8 reviews cycle through the parsed-patch cache.
test("turns that can't change a guide, as the review-state poll's lifecycle writes, don't read its review's patch again", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  // Migrated by the Store's own open; counted from here.
  createStore(bb);
  const { counted, counts } = countingPatchReads(testSql(bb));
  const backend = storeOn(counted);
  const keys = Array.from({ length: 10 }, (_, i) => `pr-${i}`);
  for (const [i, key] of keys.entries()) {
    await backend.saveReview({ targetKey: key, kind: "pr", repo: "acme/web", number: i + 1, status: "ready", createdAt: i, projectId: "p1" });
    await backend.savePatch(key, patchOf(true));
    await backend.saveGuide(key, guideOf("T") as never);
  }
  const view = await createConfigureView(bb, backend);
  const store = queueStore(view.backend, { afterTurn: view.afterTurn });
  const before = counts.patchReads;
  for (const poll of [0, 1]) for (const [i, key] of keys.entries()) await store.exclusive(async (tx) => { await tx.setLifecycle(key, { turnGroup: poll ? "waiting" : "needs", pushCheckTriedAt: i }); });
  expect(counts.patchReads - before).toBe(0);
  expect(view.review("pr-3")?.turnGroup).toBe("waiting");
  // A guide saved is read again, with its renames.
  await store.saveGuide("pr-3", guideOf("New") as never);
  expect(view.guide("pr-3")).toMatchObject({ title: "New", sections: [{ diffs: [{ file: "new.ts" }] }] });
});
