import { describe, test, expect, vi } from "vitest";
import { failingCall, testStore } from "./test-store.test-support";

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

// startPlugin finds the store the plugin queues its calls through.
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPrReview } from "./start-review";
import { defaultPreferences } from "./preferences";
import * as gh from "./gh";
import { targetKey } from "./targets";
import plugin from "../server";
import type { AsyncStore } from "./store-queue";
import { getConversation, newConversation } from "./agent";
import { startPlugin } from "./plugin-store.test-support";
import { rerunReview } from "./rereview";

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

// bug bash D1: the review was saved generating before its diff, so a diff that failed to save left it generating with
// none, which Rebuild and starting it again only opened, and Delete refused.
test("a start whose diff fails to save leaves no review generating, and starting again builds it", async () => {
  const { bb } = createFakePluginHost({
    pluginId: "code-review-workspace",
    sdk: { threads: { spawn: async () => ({ id: "th_1" }), wait: async () => {}, archive: async () => {}, stop: async () => {} } },
  });
  const store = testStore(bb);
  await expect(createPrReview({ bb, store: failingCall(store, "savePatch"), gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" })).rejects.toThrow("Connection terminated");
  expect(await store.getReview(key)).toBeNull();
  expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" })).toEqual({ ok: true, targetKey: key });
  expect(await store.patch(key)).toContain("diff --git a/a.ts");
});

describe("a review agent picked as the review starts", () => {
  const machines = [
    { id: "host_server", name: "bb-server-0", status: "connected", type: "persistent", lifecycle: { phase: "active" } },
    { id: "host_maxbook", name: "MaxBook", status: "connected", type: "persistent", lifecycle: { phase: "active" } },
    { id: "host_old", name: "FloMac Original", status: "disconnected", type: "persistent", lifecycle: { phase: "active" } },
  ];
  const settingsAgent = { providerId: "claude-code", model: "opus", reasoningLevel: "high", permissionMode: "full" } as const;
  const picked = { hostId: "host_maxbook", providerId: "codex", model: "gpt-6", reasoningLevel: "low", serviceTier: "fast" };

  /** A host whose guide writer submits its guide as soon as it's waited on, so the review agent starts after it. */
  async function host() {
    let store: AsyncStore;
    const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
      threads: {
        spawn: async ({ title }: { title: string }) => ({ id: title.startsWith("Generate guide") ? "writer" : "agent" }),
        wait: async ({ threadId }: { threadId: string }) => { if (threadId === "writer") await store.saveGuide(key, { title: "G", intent: "I", sections: [], unplacedFiles: [] }); },
        archive: async () => {}, stop: async () => {}, get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }),
      },
      projects: { list: async () => [{ id: "p1", kind: "standard" }, { id: "proj_personal", kind: "personal" }] },
      hosts: { get: async ({ hostId }: { hostId: string }) => machines.find((m) => m.id === hostId) ?? Promise.reject(Object.assign(new Error("HTTP 404"), { status: 404 })) },
    } as any });
    store = testStore(bb);
    await store.savePreferences({ ...defaultPreferences, assistantAgent: settingsAgent }, 0);
    const spawned = async () => {
      await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2));
      return harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => args as any);
    };
    return { bb, store, spawned };
  }

  test("with no pick, the review agent is Settings', on the machine and permissions Settings give it", async () => {
    const { bb, store, spawned } = await host();
    expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" })).toEqual({ ok: true, targetKey: key });
    expect((await store.getReview(key))?.reviewAgent).toBeUndefined();
    const [, agent] = await spawned();
    expect(agent).toMatchObject({ title: expect.stringMatching(/^Review agent: /), projectId: "p1", environment: { type: "project-default" }, providerId: "claude-code", model: "opus", reasoningLevel: "high", permissionMode: "full" });
  });

  test("a pick starts the review agent on its provider, model, effort, tier and machine, and leaves Settings as they were", async () => {
    const { bb, store, spawned } = await host();
    const before = await store.getPreferences();
    expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1", agent: picked })).toEqual({ ok: true, targetKey: key });
    expect((await store.getReview(key))?.reviewAgent).toEqual(picked);
    const [writer, agent] = await spawned();
    // The guide writer is Settings', untouched by the pick.
    expect(writer).toMatchObject({ title: expect.stringMatching(/^Generate guide: /), projectId: "p1", environment: { type: "project-default" } });
    expect(agent).toMatchObject({
      title: expect.stringMatching(/^Review agent: /),
      projectId: "proj_personal", environment: { type: "host", hostId: "host_maxbook", workspace: { type: "personal" } },
      providerId: "codex", model: "gpt-6", reasoningLevel: "low", serviceTier: "fast",
      executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", serviceTier: "explicit" },
    });
    // Settings' permission mode is for its own provider.
    expect(agent).not.toHaveProperty("permissionMode");
    expect(await store.getPreferences()).toEqual(before);
    // Its next conversation starts on the pick too; another review's, on Settings'.
    await newConversation(bb, store, key);
    expect((await getConversation(bb, store, key)).defaults).toEqual(picked);
    await store.saveReview({ targetKey: "pr-other", kind: "pr", status: "ready", createdAt: 1, projectId: "p1" });
    expect((await getConversation(bb, store, "pr-other")).defaults).toEqual({ providerId: "claude-code", model: "opus", reasoningLevel: "high" });
  });

  test("a pick on the provider Settings chose keeps Settings' permission mode", async () => {
    const { bb, store, spawned } = await host();
    await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1", agent: { providerId: "claude-code", model: "sonnet", reasoningLevel: "medium" } });
    const [, agent] = await spawned();
    expect(agent).toMatchObject({ projectId: "p1", environment: { type: "project-default" }, providerId: "claude-code", model: "sonnet", reasoningLevel: "medium", permissionMode: "full" });
  });

  test("a pick on an offline machine stops the review before the PR is fetched", async () => {
    const { bb, store } = await host();
    vi.mocked(gh.runGh).mockClear();
    expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1", agent: { ...picked, hostId: "host_old" } }))
      .toEqual({ ok: false, error: "FloMac Original is offline. Wake it, or choose another machine for the review agent here." });
    expect(gh.runGh).not.toHaveBeenCalled();
    expect(await store.getReview(key)).toBeNull();
  });

  test("startReview passes the pick through, and refuses one that isn't an agent selection", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
      threads: { spawn: async () => ({ id: "writer" }), wait: async () => {}, archive: async () => {}, stop: async () => {} },
      projects: { list: async () => [{ id: "proj_personal", kind: "personal" }] },
      hosts: { get: async ({ hostId }: { hostId: string }) => machines.find((m) => m.id === hostId) },
    } as any });
    const store = await startPlugin(bb);
    expect(await harness.behavior.callRpc("startReview", { input: "https://github.com/acme/web/pull/7", agent: picked })).toEqual({ ok: true, targetKey: key });
    expect((await store.getReview(key))?.reviewAgent).toEqual(picked);
    await expect(harness.behavior.callRpc("startReview", { input: "https://github.com/acme/web/pull/7", agent: { ...picked, permissionMode: "full" } })).rejects.toThrow();
  });
});

describe("a guide writer picked as a review's guide is built", () => {
  const machines = [
    { id: "host_server", name: "bb-server-0", status: "connected", type: "persistent", lifecycle: { phase: "active" } },
    { id: "host_maxbook", name: "MaxBook", status: "connected", type: "persistent", lifecycle: { phase: "active" } },
    { id: "host_old", name: "FloMac Original", status: "disconnected", type: "persistent", lifecycle: { phase: "active" } },
  ];
  const settingsWriter = { providerId: "claude-code", model: "opus", reasoningLevel: "high", permissionMode: "accept-edits" } as const;
  const picked = { hostId: "host_maxbook", providerId: "codex", model: "gpt-6", reasoningLevel: "low", serviceTier: "fast" };

  /** The plugin, on a host whose guide writer submits its guide once it's waited on, with a tracked PR in project p1. */
  async function host(guideAgent: typeof settingsWriter | null = settingsWriter) {
    let store: AsyncStore;
    const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
      threads: {
        spawn: async ({ title }: { title: string }) => ({ id: title.startsWith("Generate guide") ? "writer" : "agent" }),
        wait: async ({ threadId }: { threadId: string }) => { if (threadId === "writer") await store.saveGuide(key, { title: "G", intent: "I", sections: [], unplacedFiles: [] }); },
        archive: async () => {}, stop: async () => {}, get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }),
      },
      projects: {
        list: async () => [{ id: "p1", kind: "standard" }, { id: "proj_personal", kind: "personal" }],
        defaultExecutionOptions: async ({ projectId }: { projectId: string }) => projectId === "p1"
          ? { providerId: "claude-code", model: "haiku", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default" }
          : { providerId: "codex", model: "gpt-6", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default" },
      },
      // Each machine's own providers: Codex runs on the laptop alone.
      providers: { list: async (input?: { hostId?: string }) => input?.hostId === "host_maxbook"
        ? [{ id: "codex", available: true, capabilities: { permissionModes: ["auto", "full"] } }]
        : [{ id: "claude-code", available: true, capabilities: { permissionModes: ["accept-edits", "auto", "full"] } }] },
      hosts: { get: async ({ hostId }: { hostId: string }) => machines.find((m) => m.id === hostId) ?? Promise.reject(Object.assign(new Error("HTTP 404"), { status: 404 })) },
    } as any });
    store = await startPlugin(bb);
    await store.savePreferences({ ...defaultPreferences, guideAgent }, (await store.getPreferences()).revision);
    await store.saveReview({ targetKey: key, kind: "pr", number: 7, repo: "acme/web", status: "tracked", createdAt: 1, projectId: "p1" });
    const writer = async () => {
      await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn").length).toBeGreaterThan(0));
      return harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as any;
    };
    return { bb, harness, store, writer };
  }

  test("with no pick, Build the guide spawns Settings' guide writer, as before", async () => {
    const { harness, writer } = await host();
    expect(await harness.behavior.callRpc("startTrackedReview", { targetKey: key })).toEqual({ ok: true });
    expect(await writer()).toMatchObject({ title: expect.stringMatching(/^Generate guide: /), projectId: "p1", environment: { type: "project-default" },
      providerId: "claude-code", model: "opus", reasoningLevel: "high", permissionMode: "accept-edits" });
  });

  test("a pick builds the guide on its provider, model, effort, tier and machine, for that build alone, and leaves Settings as they were", async () => {
    const { bb, harness, store, writer } = await host();
    const before = await store.getPreferences();
    expect(await harness.behavior.callRpc("startTrackedReview", { targetKey: key, agent: picked })).toEqual({ ok: true });
    expect(await writer()).toMatchObject({
      title: expect.stringMatching(/^Generate guide: /), visibility: "hidden",
      projectId: "proj_personal", environment: { type: "host", hostId: "host_maxbook", workspace: { type: "personal" } },
      providerId: "codex", model: "gpt-6", reasoningLevel: "low", serviceTier: "fast",
      // Not Settings' mode, which is for Settings' provider: the lowest the picked provider runs in, on the picked
      // machine, whose providers the server's don't list.
      permissionMode: "auto",
      executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", serviceTier: "explicit", permissionMode: "explicit" },
    });
    expect(harness.inspection.sdk.callsTo("providers.list")).toContainEqual([{ hostId: "host_maxbook" }]);
    expect(await store.getPreferences()).toEqual(before);
    // Nothing of the pick is kept: the next build is Settings' writer's again.
    await vi.waitFor(async () => expect((await store.getReview(key))?.status).toBe("ready"));
    expect((await store.getReview(key))?.reviewAgent).toBeUndefined();
    await rerunReview({ bb, store, gh }, key);
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn").filter(([args]) => (args as any).title.startsWith("Generate guide"))).toHaveLength(2));
    const rebuilt = harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => args as any).filter((args) => args.title.startsWith("Generate guide"))[1];
    expect(rebuilt).toMatchObject({ projectId: "p1", environment: { type: "project-default" }, providerId: "claude-code", model: "opus", permissionMode: "accept-edits" });
  });

  test("a pick on the provider Settings chose keeps Settings' permission mode", async () => {
    const { harness, writer } = await host();
    await harness.behavior.callRpc("startTrackedReview", { targetKey: key, agent: { providerId: "claude-code", model: "sonnet", reasoningLevel: "medium" } });
    expect(await writer()).toMatchObject({ projectId: "p1", environment: { type: "project-default" }, providerId: "claude-code", model: "sonnet", reasoningLevel: "medium", permissionMode: "accept-edits" });
  });

  test("a pick over the project's defaults runs at the lowest permission mode its provider runs in, as the defaults do", async () => {
    const { harness, writer } = await host(null);
    await harness.behavior.callRpc("startTrackedReview", { targetKey: key, agent: { providerId: "claude-code", model: "sonnet", reasoningLevel: "low" } });
    expect(await writer()).toMatchObject({ projectId: "p1", environment: { type: "project-default" }, providerId: "claude-code", model: "sonnet", reasoningLevel: "low", permissionMode: "accept-edits" });
  });

  test("a pick on an offline machine stops the build before the PR is read", async () => {
    const { harness, store } = await host();
    vi.mocked(gh.runGh).mockClear();
    expect(await harness.behavior.callRpc("startTrackedReview", { targetKey: key, agent: { ...picked, hostId: "host_old" } }))
      .toEqual({ ok: false, error: "FloMac Original is offline. Wake it, or choose another machine for the guide writer here." });
    expect(gh.runGh).not.toHaveBeenCalled();
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    expect((await store.getReview(key))?.status).toBe("tracked");
  });

  test("Try again on a failed guide passes the pick through, and a pick with a permission mode is refused", async () => {
    const { harness, store, writer } = await host();
    await store.saveReview({ targetKey: key, kind: "pr", number: 7, repo: "acme/web", status: "error", createdAt: 1, projectId: "p1" });
    expect(await harness.behavior.callRpc("rereview", { targetKey: key, agent: picked })).toEqual({ ok: true });
    expect(await writer()).toMatchObject({ environment: { type: "host", hostId: "host_maxbook" }, providerId: "codex", model: "gpt-6" });
    await expect(harness.behavior.callRpc("startTrackedReview", { targetKey: key, agent: { ...picked, permissionMode: "full" } })).rejects.toThrow();
  });

  test("the picker's defaults are those of the project the review's agents run in", async () => {
    const { harness } = await host(null);
    expect(await harness.behavior.callRpc("getAgentDefaults", { targetKey: key })).toMatchObject({ defaults: { providerId: "claude-code", model: "haiku" } });
    expect(await harness.behavior.callRpc("getAgentDefaults", null)).toMatchObject({ defaults: { providerId: "codex", model: "gpt-6" } });
  });
});
