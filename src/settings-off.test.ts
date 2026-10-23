import { expect, test, vi } from "vitest";
import { testStore } from "./test-store.test-support";

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
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { defaultPreferences } from "./preferences";
import { defaultKnobs, type Knobs } from "../lib/knobs";
import { generateGuide } from "./generate";
import { createReviewSync, type GithubReads, type TurnActions } from "./review-lifecycle";
import type { PrFacts, PrRef } from "./github/types";
import { runGit } from "./gh";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolText } from "./fake-host.test-support";
import { queueStore, type AsyncStore } from "./store-queue";
import { startPlugin } from "./plugin-store.test-support";

/** What the reviewer's page shows of the draft, which submitReview takes to check it still matches. */
const shown = async (store: AsyncStore, targetKey: string) => {
  const { comments, body, verdict } = await store.getDraft(targetKey);
  return { comments, body, verdict };
};

// Every toggle off; the server reads no number knob.
const allKnobsOff = Object.fromEntries(Object.entries(defaultKnobs).map(([id, value]) => [id, typeof value === "boolean" ? false : value])) as unknown as Knobs;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-10T12:00:00Z");

async function host() {
  const delivered: unknown[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: { spawn: async () => ({ id: "worker" }), archive: async () => ({}), stop: async () => ({}), update: async () => ({}), send: async () => ({}),
      get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }) },
    projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }) },
    plugins: { callRpc: async ({ method, input }: any) => {
      if (method === "activityCapabilities") return { version: 1 };
      delivered.push(input);
      return { accepted: true, id: "activity", duplicate: false, ok: true };
    } },
  } as any });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, author: "alice", headSha: "sha1", status: "generating", createdAt: 1, projectId: "p1" });
  await store.setLifecycle("pr-1", { authorAssociation: "MEMBER", ownPr: false });
  await store.savePreferences({ ...defaultPreferences, knobs: allKnobsOff }, 0);
  return { bb, harness, store, delivered };
}

test("with every toggle off, a member's ready guide starts no assistant and alerts nothing", async () => {
  const { bb, harness, store, delivered } = await host();
  harness.inspection.sdk.stub("threads.wait", async () => {
    await store.saveGuide("pr-1", { title: "T", intent: "I", sections: [], unplacedFiles: [] });
    return { matched: true };
  });
  await generateGuide(bb, store, "pr-1", "p1", { unattended: true });
  expect((await store.getReview("pr-1"))?.status).toBe("ready");
  expect(harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => (args as any).title)).toEqual(["Generate guide: pr-1"]);
  // The automatic review is off, so nothing waits for a click either.
  expect((await store.getReview("pr-1"))?.skippedRun).toBeUndefined();
  expect(delivered).toEqual([]);
});

test("with every toggle off, a member's re-request on an out-of-date review starts nothing and alerts nothing", async () => {
  const { bb, store, delivered } = await host();
  await store.setStatus("pr-1", "ready");
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
    expect(await store.getReview("pr-1")).toMatchObject({ notifiedSignal: `re-requested:${T0 + 0.1 * HOUR}`, pendingAlert: null });
    expect(delivered).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("with every toggle off, a review still submits", async () => {
  const { bb, harness, store } = await host();
  await plugin(bb);
  await store.setStatus("pr-1", "ready");
  await store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, comment: { file: "a.ts", line: 1, side: "RIGHT", body: "nit" } });
  await harness.behavior.callRpc("saveSummary", { targetKey: "pr-1", revision, body: "ok" });
  await harness.behavior.callRpc("setVerdict", { targetKey: "pr-1", revision, verdict: "COMMENT" });
  expect(await harness.behavior.callRpc("submitReview", { targetKey: "pr-1", revision, account: "casey", ...await shown(store, "pr-1") })).toMatchObject({ ok: true });
  expect(submit).toHaveBeenCalled();
});

test("with every toggle off, a comment on code the PR didn't change posts like any other, and the assistant isn't asked to mark one", async () => {
  const { store } = await host();
  await store.setStatus("pr-1", "ready");
  await store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", author: "agent", severity: "blocking", body: "Already racy.", introduced: false });
  await store.setVerdict("pr-1", "COMMENT", "ok");
  const run = vi.fn(async (args: string[]) => ({ code: 0, stderr: "", stdout: args[0] === "pr" ? JSON.stringify({ headRefOid: "sha1" }) : "{}" }));
  const { createReviewSubmitter } = await import("./submit-review");
  const { comments, body, verdict } = await store.getDraft("pr-1");
  expect(await createReviewSubmitter(store, run as any)("pr-1", undefined, undefined, comments, { body, verdict })).toMatchObject({ ok: true });
  expect(JSON.parse((run.mock.calls.at(-1) as any)[1].stdin).comments[0].body).toBe("**Blocking:** Already racy.");
  const { assistantInstructions } = await import("./agent");
  expect(assistantInstructions("pr-1", null, (await store.getPreferences()).preferences)).not.toContain("introduced");
});

test("with every toggle off, the assistant isn't asked what it didn't check", async () => {
  const { store } = await host();
  const { assistantInstructions } = await import("./agent");
  expect(assistantInstructions("pr-1", null, (await store.getPreferences()).preferences)).not.toContain("unchecked");
});

test("with every toggle off, list_review_files marks no test weakened and the assistant isn't asked to check one", async () => {
  const { bb, harness, store } = await host();
  await plugin(bb);
  await store.savePatch("pr-1", "diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -1,2 +1 @@\n-  expect(a).toBe(1);\n+it.skip(\"a\", () => {\n");
  await store.setAssistantThread("pr-1", "assistant");
  const listed = await harness.behavior.callAgentTool("list_review_files", { targetKey: "pr-1" }, { threadId: "assistant" });
  expect(JSON.stringify(listed)).toContain("a.test.ts · modified");
  expect(JSON.stringify(listed)).not.toContain("weakened");
  const { assistantInstructions } = await import("./agent");
  expect(assistantInstructions("pr-1", null, (await store.getPreferences()).preferences)).not.toContain("weakened");
});

test("with every toggle off, list_review_files and a page's stub show a lockfile without its digest, the stub naming only a new host", async () => {
  const { bb, harness, store } = await host();
  await plugin(bb);
  await store.savePatch("pr-1", "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1,2 @@\n-    \"node_modules/a\": {\n+    \"node_modules/b\": {\n+      \"resolved\": \"https://evil.example.com/b.tgz\",\n");
  await store.setAssistantThread("pr-1", "assistant");
  const listed = JSON.stringify(await harness.behavior.callAgentTool("list_review_files", { targetKey: "pr-1" }, { threadId: "assistant" }));
  const paged = JSON.stringify(await harness.behavior.callAgentTool("read_review_patch", { targetKey: "pr-1" }, { threadId: "assistant" }));
  expect(listed).toContain("package-lock.json · modified");
  // The agents read the whole lockfile in 0.7.0, so its stub still names where a package now downloads from.
  expect(paged).toContain("[lockfile: +2 −1 lines; downloads from evil.example.com; pass file to read it]");
  expect(paged).not.toMatch(/packages/);
  expect(listed).not.toMatch(/packages|evil\.example\.com/);
});

test("with Ask why off, a removal takes no reason, and neither the agent nor Settings sees one given while it was on", async () => {
  const { bb, harness, store } = await host();
  await plugin(bb);
  await store.setStatus("pr-1", "ready");
  await store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  await store.setAssistantThread("pr-1", "assistant");
  const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  const tool = (name: string, input: Record<string, unknown>) => harness.behavior.callAgentTool(name, input, { threadId: "assistant" }) as Promise<any>;
  const at = { file: "a.ts", line: 1, side: "RIGHT" } as const;
  await tool("add_draft_comment", { ...at, code: "one", body: "Why one?" });
  await rpc("removeDraftComment", { targetKey: "pr-1", ...at });
  expect(await rpc("setRemovalReason", { targetKey: "pr-1", ...at, reason: "wrong" })).toEqual({ ok: false });
  expect(await store.agentCommentChanges("pr-1")).toEqual([expect.objectContaining({ kind: "removed", why: null })]);
  await store.setRemovalReason("pr-1", at, { reason: "wrong", note: "Not a bug." });
  await store.recordAgentOutcomes("pr-1", [{ repo: "acme/web", file: "a.ts", outcome: "removed", body: "Why one?", edited: null }]);
  const listed = await tool("list_draft_comments", {});
  expect(listed).toContain("Why one?");
  expect(listed).not.toContain("why:");
  expect(await rpc("getAgentLearning", null)).toMatchObject({ removed: 1, reasons: [] });
});

test("with Move to summary off, a comment on an older diff stays put until it's edited or removed", async () => {
  const { bb, harness, store } = await host();
  await plugin(bb);
  await store.setStatus("pr-1", "ready");
  await store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "Why one?" });
  await store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+uno\n");
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  await expect(harness.behavior.callRpc("moveToSummary", { targetKey: "pr-1", revision, file: "a.ts", line: 1, side: "RIGHT" })).rejects.toThrow("Move to summary is off in Settings.");
  expect(await store.getDraft("pr-1")).toMatchObject({ body: "", comments: [{ file: "a.ts", line: 1, body: "Why one?" }] });
});

test("with Stop a guide while it builds off, Stop is refused and the guide runs until it's done", async () => {
  const { bb, harness, store } = await host();
  await plugin(bb);
  let finish = async () => {};
  harness.inspection.sdk.stub("threads.wait", () => new Promise((resolve) => { finish = async () => {
    await store.saveGuide("pr-1", { title: "T", intent: "I", sections: [], unplacedFiles: [] });
    resolve({ matched: true });
  }; }));
  const run = generateGuide(bb, store, "pr-1", "p1", { unattended: true });
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.wait")).toHaveLength(1));
  expect(await harness.behavior.callRpc("stopGuide", { targetKey: "pr-1" })).toMatchObject({ ok: false });
  expect((await store.getReview("pr-1"))?.status).toBe("generating");
  await finish();
  await run;
  expect((await store.getReview("pr-1"))?.status).toBe("ready");
});

test("with Dig deeper on a chapter off, Dig deeper is refused and nothing reaches the assistant", async () => {
  const { bb, harness, store } = await host();
  await plugin(bb);
  await store.setStatus("pr-1", "ready");
  await store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  await store.saveGuide("pr-1", { title: "T", intent: "I", unplacedFiles: [], sections: [{ id: "c1", title: "Parsing", overview: "O", risk: "high", focus: ["Check that it parses."], diffs: [{ file: "a.ts", summary: "S" }] }] });
  await store.setAssistantThread("pr-1", "assistant");
  expect(await harness.behavior.callRpc("digDeeper", { targetKey: "pr-1", chapterId: "c1" })).toMatchObject({ ok: false });
  expect(harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
  expect((await store.getReview("pr-1"))?.deepDive).toBeUndefined();
});

test("with Comment on or ask about a failing check off, a check's log isn't read", async () => {
  const { bb, harness } = await host();
  await plugin(bb);
  expect(await harness.behavior.callRpc("getCheckLog", { targetKey: "pr-1", runId: 77 })).toEqual({ ok: false, error: "Asking about a failing check is off in Settings." });
});

test("with every toggle off, a local review whose code changed says nothing new", async () => {
  const { bb, harness, store } = await host();
  await plugin(bb);
  const cwd = await mkdtemp(join(tmpdir(), "code-review-workspace-"));
  try {
    for (const args of [["init", "-b", "main"], ["-c", "user.name=R", "-c", "user.email=r@example.invalid", "commit", "--allow-empty", "-m", "start"]]) expect((await runGit(args, { cwd })).code).toBe(0);
    await writeFile(join(cwd, "a.ts"), "edited\n");
    await runGit(["add", "a.ts"], { cwd });
    await store.saveReview({ targetKey: "local", kind: "ref", gitRef: "HEAD", cwd, status: "ready", createdAt: 1, projectId: "p1" });
    await store.savePatch("local", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+before\n");
    expect(await harness.behavior.callRpc("checkForUpdates", { targetKey: "local" })).toEqual({ hasNewCommits: false });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("with every toggle off, a review a thread started offers no thread to send to and sends nothing", async () => {
  const { bb, harness, store } = await host();
  await plugin(bb);
  await store.setLifecycle("pr-1", { ownPr: true, sourceThreadId: "coder" });
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "Fix it." });
  expect(await harness.behavior.callRpc("getSourceThread", { targetKey: "pr-1" })).toEqual({ thread: null });
  await expect(harness.behavior.callRpc("sendToSourceThread", { targetKey: "pr-1", comments: [{ file: "a.ts", line: 1, side: "RIGHT" }] })).rejects.toThrow("Send to thread is off");
  await expect(harness.behavior.callRpc("sendApprovalToSourceThread", { targetKey: "pr-1" })).rejects.toThrow("Send to thread is off");
  expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
});

test("with every toggle off, agents in your threads get no bb review skill, and bb review lists nothing", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", agentSkillIds: ["code-review-workspace-generate", "code-review-workspace"] });
  const store = await startPlugin(bb);
  await store.savePreferences({ ...defaultPreferences, knobs: allKnobsOff }, 0);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, title: "Cache rows", status: "ready", createdAt: 1, projectId: "p1" });
  const ordinary = { thread: { id: "mine", title: "Fix it", parentThreadId: null, sourceThreadId: null }, origin: { kind: null, pluginId: null } } as any;
  expect(await harness.behavior.resolveAgentConfiguration(ordinary)).toMatchObject({ tools: [], skills: [] });
  expect((await harness.behavior.runCli(["list", "--json"], { threadId: "mine", projectId: "p1" })).stdout ?? "").not.toContain("Cache rows");
});

test("with Read REVIEW.md off, read_pr_context reads the repo's other instructions and no REVIEW.md", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gr-settings-off-"));
  const repo = (...args: string[]) => runGit(args, { cwd });
  await repo("init", "-q", "-b", "main");
  await repo("config", "user.email", "t@example.com");
  await repo("config", "user.name", "t");
  writeFileSync(join(cwd, "AGENTS.md"), "Run the tests.");
  writeFileSync(join(cwd, "REVIEW.md"), "Flag every new dependency.");
  writeFileSync(join(cwd, "a.ts"), "a");
  await repo("add", ".");
  await repo("commit", "-qm", "base");
  const { bb, harness, store } = await host();
  await plugin(bb);
  await store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "main", cwd, status: "ready", createdAt: 1 });
  await store.savePatch("ref-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n");
  await store.setAssistantThread("ref-1", "assistant");
  const read = async () => toolText(await harness.behavior.callAgentTool("read_pr_context", {}, { threadId: "assistant" }));
  const off = await read();
  expect(off).toContain("## AGENTS.md\nRun the tests.");
  expect(off).not.toContain("Flag every new dependency.");
  await store.savePreferences({ ...defaultPreferences, knobs: { ...allKnobsOff, reviewMd: true } }, (await store.getPreferences()).revision);
  expect(await read()).toContain("## REVIEW.md, the repo's review rules\nFlag every new dependency.");
});
