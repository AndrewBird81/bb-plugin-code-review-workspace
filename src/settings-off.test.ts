import { expect, test, vi } from "vitest";

const submit = vi.hoisted(() => vi.fn(async () => ({ stdout: JSON.stringify({ id: 1, node_id: "PRR_1", html_url: "u" }), stderr: "", code: 0 })));
vi.mock("./gh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gh")>();
  return {
    ...actual,
    runGh: (args: string[]) => args[0] === "auth" ? Promise.resolve({ stdout: "test-token", stderr: "", code: 0 })
      : args[1] === "user" ? Promise.resolve({ stdout: "casey", stderr: "", code: 0 })
      : args.some((a) => a.includes("reviews")) ? submit()
      : Promise.resolve({ stdout: JSON.stringify({ headRefOid: "sha1" }), stderr: "", code: 0 }),
  };
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { defaultPreferences } from "./preferences";
import { defaultKnobs, type Knobs } from "../lib/knobs";
import { generateGuide } from "./generate";
import { createReviewSync, type GithubReads, type TurnActions } from "./review-lifecycle";
import type { PrFacts, PrRef } from "./github/types";

// Every toggle off; the server reads no number knob.
const allKnobsOff = Object.fromEntries(Object.entries(defaultKnobs).map(([id, value]) => [id, typeof value === "boolean" ? false : value])) as unknown as Knobs;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-10T12:00:00Z");

function host() {
  const delivered: unknown[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: {
    threads: { spawn: async () => ({ id: "worker" }), archive: async () => ({}), stop: async () => ({}), update: async () => ({}), send: async () => ({}),
      get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }) },
    projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }) },
    plugins: { callRpc: async ({ method, input }: any) => {
      if (method === "activityCapabilities") return { version: 1 };
      delivered.push(input);
      return { accepted: true, id: "activity", duplicate: false, ok: true };
    } },
  } as any });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, author: "alice", headSha: "sha1", status: "generating", createdAt: 1, projectId: "p1" });
  store.setLifecycle("pr-1", { authorAssociation: "MEMBER", ownPr: false });
  store.savePreferences({ ...defaultPreferences, knobs: allKnobsOff }, 0);
  return { bb, harness, store, delivered };
}

test("with every toggle off, a member's ready guide starts no assistant and alerts nothing", async () => {
  const { bb, harness, store, delivered } = host();
  harness.inspection.sdk.stub("threads.wait", async () => {
    store.saveGuide("pr-1", { title: "T", intent: "I", sections: [], unplacedFiles: [] });
    return { matched: true };
  });
  await generateGuide(bb, store, "pr-1", "p1", { unattended: true });
  expect(store.getReview("pr-1")?.status).toBe("ready");
  expect(harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => (args as any).title)).toEqual(["Generate guide: pr-1"]);
  // The automatic review is off, so nothing waits for a click either.
  expect(store.getReview("pr-1")?.skippedRun).toBeUndefined();
  expect(delivered).toEqual([]);
});

test("with every toggle off, a member's re-request on an out-of-date review starts nothing and alerts nothing", async () => {
  const { bb, store, delivered } = host();
  store.setStatus("pr-1", "ready");
  vi.useFakeTimers({ toFake: ["Date"] });
  let now = T0;
  vi.setSystemTime(now);
  let pr: Partial<PrFacts> = { myReviews: [{ id: "r-1", state: "CHANGES_REQUESTED", submittedAt: T0 - 5 * HOUR, sha: "sha1", body: "" }] };
  const github: GithubReads = {
    viewer: { login: async () => "me", teams: async () => new Set<string>(), reset() {} },
    gate: { poll: async () => ({ kind: "unchanged" }) },
    facts: async (refs: PrRef[]) => new Map(refs.map((ref) => [ref.targetKey, {
      targetKey: ref.targetKey, repo: ref.repo, number: ref.number, state: "OPEN", isDraft: false, title: "T", url: "https://github.com/acme/web/pull/1",
      author: "alice", authorAssociation: "MEMBER", baseRefName: "main", headRefName: "cache", headSha: "sha1", updatedAt: 1, ci: "pass",
      myReviews: [], otherOpinions: [], requests: [], size: null, requestPending: null, mention: null, commits: ["sha1"], ...pr,
    } as PrFacts])),
    threads: async () => [],
    discover: vi.fn(async () => []),
  };
  const actions: TurnActions = { prepare: vi.fn(async () => true), checkPushes: vi.fn(async () => true), autoStart: vi.fn(async () => true), projectId: async () => "p1" };
  try {
    const sync = createReviewSync(bb, store, vi.fn() as any, { github, actions, now: () => now });
    await sync.all();
    pr = { ...pr, headSha: "sha2", commits: ["sha1", "sha2"], requests: [{ at: T0 + 0.1 * HOUR, by: "alice", via: "user" }] };
    now = T0 + 0.2 * HOUR;
    vi.setSystemTime(now);
    await sync.all(true);
    now = T0 + HOUR;
    vi.setSystemTime(now);
    await sync.all(true);
    expect(actions.prepare).not.toHaveBeenCalled();
    expect(actions.autoStart).not.toHaveBeenCalled();
    expect(github.discover).toHaveBeenCalledWith({ reviewed: false, teams: false });
    expect(store.getReview("pr-1")).toMatchObject({ notifiedSignal: `re-requested:${T0 + 0.1 * HOUR}`, pendingAlert: null });
    expect(delivered).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("with every toggle off, a review still submits", async () => {
  const { bb, harness, store } = host();
  await plugin(bb);
  store.setStatus("pr-1", "ready");
  store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, comment: { file: "a.ts", line: 1, side: "RIGHT", body: "nit" } });
  await harness.behavior.callRpc("saveSummary", { targetKey: "pr-1", revision, body: "ok" });
  await harness.behavior.callRpc("setVerdict", { targetKey: "pr-1", revision, verdict: "COMMENT" });
  expect(await harness.behavior.callRpc("submitReview", { targetKey: "pr-1", revision, account: "casey" })).toMatchObject({ ok: true });
  expect(submit).toHaveBeenCalled();
});
