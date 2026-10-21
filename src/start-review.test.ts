import { test, expect, vi } from "vitest";
import { testStore } from "./test-store.test-support";

vi.mock("./gh", async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    runGh: vi.fn(async (args: string[]) => {
      if (args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 7,
            title: "Fix the thing",
            body: "b",
            author: { login: "a" },
            baseRefName: "main",
            headRefName: "f",
            url: "https://github.com/acme/web/pull/7",
            headRefOid: "abc123",
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[1] === "diff") {
        return { stdout: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-o\n+n\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }),
    runGit: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  };
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPrReview } from "./start-review";
import { defaultPreferences } from "./preferences";
import * as gh from "./gh";
import { targetKey } from "./targets";
import plugin from "../server";
import type { AsyncStore } from "./store-queue";

const key = targetKey({ kind: "pr", number: 7, repo: "acme/web" });

test("createPrReview stores the review + patch and returns ok with a targetKey", async () => {
  const { bb } = createFakePluginHost({
    pluginId: "code-review-workspace",
    sdk: { threads: { spawn: async () => ({ id: "th_1" }), wait: async () => {}, archive: async () => {}, stop: async () => {} } },
  });
  const store = testStore(bb);

  const res = await createPrReview(
    { bb, store, gh },
    { input: "https://github.com/acme/web/pull/7", projectId: "p1" },
  );

  expect(res.ok).toBe(true);
  expect(res.targetKey).toBe(key);

  const meta = await store.getReview(key);
  expect(meta?.repo).toBe("acme/web");
  expect(meta?.title).toBe("Fix the thing");
  expect(meta?.headSha).toBe("abc123");
  expect(meta?.projectId).toBe("p1");
  expect(await store.patch(key)).toContain("diff --git a/a.ts");
});

test("starting an archived PR's review again returns it to the queue", async () => {
  const { bb } = createFakePluginHost({
    pluginId: "code-review-workspace",
    sdk: { threads: { spawn: async () => ({ id: "th_1" }), wait: async () => {}, archive: async () => {}, stop: async () => {} } },
  });
  const store = testStore(bb);
  await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" });
  await store.setLifecycle(key, { userArchivedAt: 1 });

  await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" });

  expect((await store.getReview(key))?.userArchivedAt).toBeNull();
});

test("createPrReview rejects a non-PR-URL input", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);

  const res = await createPrReview({ bb, store, gh }, { input: "42", projectId: "p1" });

  expect(res.ok).toBe(false);
  expect(res.targetKey).toBeUndefined();
});

test("an offline guide writer machine stops the review before the PR is fetched", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { hosts: { get: async () => ({ id: "host_flomac", name: "FloMac", status: "disconnected", lifecycle: { phase: "active" } }) } } });
  const store = testStore(bb);
  await store.savePreferences({ ...defaultPreferences, guideAgent: { hostId: "host_flomac", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" } }, 0);
  vi.mocked(gh.runGh).mockClear();
  expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" }))
    .toEqual({ ok: false, error: "FloMac is offline. Wake it, or choose another machine for the guide writer in Review settings." });
  expect(gh.runGh).not.toHaveBeenCalled();
  expect(await store.getReview(key)).toBeNull();
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
});

const reviewed = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-o\n+n\n";
async function seedReady(store: AsyncStore, headSha: string, patch: string) {
  await store.saveReview({ targetKey: key, kind: "pr", number: 7, repo: "acme/web", status: "ready", createdAt: 1, projectId: "p1", headSha, gitRef: "main...f" });
  await store.savePatch(key, patch);
  await store.saveGuide(key, { title: "Kept", intent: "I", sections: [], unplacedFiles: [] });
  await store.upsertDraftComment(key, { file: "a.ts", line: 1, side: "RIGHT", body: "Why n?" });
}

test("pasting the link of a review that hasn't changed opens it without rebuilding", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await seedReady(store, "abc123", reviewed);
  await store.setLifecycle(key, { userArchivedAt: 1 });
  expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" })).toEqual({ ok: true, targetKey: key });
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(await store.getReview(key)).toMatchObject({ status: "ready", userArchivedAt: null });
  expect((await store.getGuide(key))?.title).toBe("Kept");
  expect(await store.staleDraftComments(key)).toEqual([]);
});

test("pasting a renamed repository's PR link opens the review the sync keeps under the old name (bug bash CLI-2)", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await seedReady(store, "abc123", reviewed);
  await store.saveReview({ ...(await store.getReview(key))!, url: "https://github.com/acme/site/pull/7" });
  expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/site/pull/7", projectId: "p1" })).toEqual({ ok: true, targetKey: key });
  expect((await store.listReviews()).map((review) => review.targetKey)).toEqual([key]);
});

test("pasting a PR link tells open pages of the review it starts, rebuilds, or brings back from Archive, at once (bug bash LIV-5)", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: { spawn: () => new Promise(() => {}), wait: async () => {}, archive: async () => {}, stop: async () => {} } } });
  const store = testStore(bb);
  const channels = async () => {
    harness.inspection.realtimeSignals.length = 0;
    expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" })).toEqual({ ok: true, targetKey: key });
    return harness.inspection.realtimeSignals.map((signal) => signal.channel).sort();
  };
  expect(await channels()).toEqual([`review:${key}`, "reviews"]);
  await seedReady(store, "abc123", reviewed);
  expect(await channels()).toEqual([]);
  await store.setLifecycle(key, { userArchivedAt: 5 });
  expect(await channels()).toEqual([`review:${key}`, "reviews"]);
  await seedReady(store, "old", reviewed);
  expect(await channels()).toEqual([`review:${key}`, "reviews"]);
  expect((await store.getReview(key))?.status).toBe("generating");
});

test("pasting the link of a review with new commits rebuilds it like Re-review, keeping the guide and comments if it fails", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async () => ({ id: "w" }), wait: async () => { throw new Error("worker failed"); }, archive: async () => ({}), stop: async () => ({}),
  } } as any });
  const store = testStore(bb);
  await seedReady(store, "old", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+n\n");
  expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" })).toEqual({ ok: true, targetKey: key });
  await vi.waitFor(async () => expect((await store.getReview(key))?.status).toBe("error"));
  expect((await store.getGuide(key))?.title).toBe("Kept");
  expect((await store.getReview(key))?.headSha).toBe("old");
  expect((await store.getDraft(key)).comments).toMatchObject([{ line: 1, body: "Why n?" }]);
  expect(await store.staleDraftComments(key)).toEqual([]);
});

// A host whose guide writer never finishes, so the rebuild stays generating.
const building = () => createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
  spawn: async () => ({ id: "w" }), wait: async () => new Promise(() => {}), archive: async () => ({}), stop: async () => ({}),
} } as any });

test("pasting the link of a review with new commits keeps when it was created", async () => {
  const { bb } = building();
  const store = testStore(bb);
  await seedReady(store, "old", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+n\n");
  expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" })).toEqual({ ok: true, targetKey: key });
  expect(await store.getReview(key)).toMatchObject({ status: "generating", createdAt: 1 });
});

test("pasting the link of an archived review with new commits brings it back from Archive", async () => {
  const { bb } = building();
  const store = testStore(bb);
  await seedReady(store, "old", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+n\n");
  await store.setLifecycle(key, { userArchivedAt: 5 });
  expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" })).toEqual({ ok: true, targetKey: key });
  expect(await store.getReview(key)).toMatchObject({ status: "generating", userArchivedAt: null });
});

test("starting a PR's review records whether gh says it's merged or closed, new or rebuilt", async () => {
  const base = vi.mocked(gh.runGh).getMockImplementation()!;
  const stated = (state: string) => vi.mocked(gh.runGh).mockImplementation(async (args, opts) => {
    const out = await base(args, opts);
    return args[1] === "view" ? { ...out, stdout: JSON.stringify({ ...JSON.parse(out.stdout), state }) } : out;
  });
  try {
    const { bb } = building();
    const store = testStore(bb);
    stated("MERGED");
    expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" })).toEqual({ ok: true, targetKey: key });
    expect([(await store.getReview(key))?.startedPrState, (await store.getReview(key))?.prState]).toEqual(["MERGED", undefined]);
    // A rebuild, at a new head, reads it again; a state gh doesn't name is left.
    await seedReady(store, "old", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+n\n");
    stated("CLOSED");
    expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" })).toEqual({ ok: true, targetKey: key });
    expect((await store.getReview(key))?.startedPrState).toBe("CLOSED");
    await seedReady(store, "old", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+n\n");
    stated("DRAFTY");
    await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" });
    expect((await store.getReview(key))?.startedPrState).toBe("CLOSED");
  } finally {
    vi.mocked(gh.runGh).mockImplementation(base);
  }
});

test("starting a review from All reviews says so when bb can't name a project to run it in", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { projects: { list: async () => { throw new Error("Connection unavailable"); } } } as any });
  await plugin(bb);
  expect(await harness.behavior.callRpc("startReview", { input: "https://github.com/acme/web/pull/7" })).toEqual({ ok: false, error: "Couldn't resolve a project to run generation." });
});
