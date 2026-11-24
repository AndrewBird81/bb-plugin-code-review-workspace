import { expect, test, vi } from "vitest";
import { folderHost, type Folder } from "./env-diff.test-support";
import { toolFailed } from "./fake-host.test-support";
import { register } from "./review-pass";
import { updateFeature } from "./feature-review";
import { testStore } from "./test-store.test-support";

const key = "br-review-pass";
const owner = "goal-orchestrator";
const finding = { file: "src/app.ts", line: 1, severity: "should-fix", body: "The new value drops required behavior.", source: "agent" };

async function setup() {
  const folder: Folder = { files: [{ path: "src/app.ts" }] };
  let spawned = 0;
  const statuses = new Map<string, string>();
  const send = vi.fn(async (_request: { threadId: string; input: { text: string }[] }) => ({ delivery: "sent" }));
  const spawn = vi.fn(async (_request: { prompt: string; visibility: string; permissionMode: string }) => { const id = `pass-${++spawned}`; statuses.set(id, "active"); return { id }; });
  const { bb, harness } = folderHost(folder, {
    threads: {
      send, spawn,
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: statuses.get(threadId) ?? "idle", archivedAt: null, deletedAt: null }),
      // Never idle on its own: the test records the result, or makes it idle.
      // Resolves once the test makes the thread idle; rejects when the pass's signal aborts.
      wait: ({ threadId, signal }: { threadId: string; signal?: AbortSignal }) => new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => { if (statuses.get(threadId) === "idle") { clearInterval(timer); resolve(); } }, 5);
        signal?.addEventListener("abort", () => { clearInterval(timer); reject(new Error("aborted")); }, { once: true });
      }),
    },
    projects: {
      get: async () => ({ id: "proj_api", gitRemoteUrl: "git@github.com:acme/api.git" }),
      list: async () => [{ id: "proj_api", kind: "standard", gitRemoteUrl: "git@github.com:acme/api.git" }],
      defaultExecutionOptions: async () => ({ providerId: "codex" }),
    },
    providers: { list: async () => [{ id: "codex", capabilities: { permissionModes: ["auto"] } }] },
  });
  const store = testStore(bb);
  const changed = vi.fn();
  const fromOwnAgent = vi.fn(async (threadId: string) => threadId.startsWith("pass-") || threadId === "assistant");
  const gh = { runGh: vi.fn(), runGit: vi.fn() };
  const passes = register({ bb, store, changed, fromOwnAgent, gh }, { pollMs: 5 });
  await store.saveReview({ targetKey: key, kind: "ref", createdAt: 1, status: "ready", projectId: "proj_api" });
  const feature = { environmentId: "env1", hostId: "host_max", path: "/Users/me/src/api", machine: "MaxBook", branch: "feat/qa", baseRef: "main", repo: "acme/api" };
  await store.setLifecycle(key, { feature });
  // The guide was written for the folder as it is now.
  expect((await updateFeature({ bb, store, gh, changed }, key)).ok).toBe(true);
  await store.setLifecycle(key, { feature: { ...(await store.getReview(key))!.feature!, guideOlderThanDiff: null } });
  const cli = (name: "update" | "result" | "round", args: string[], threadId: string | null = owner) => passes.commands[name](args, { threadId: threadId ?? undefined }, undefined);
  const update = async (...args: string[]) => {
    const result = await cli("update", [key, ...args]);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout!) as { review: string; passId: string; head: string; diffHash: string; reused?: true };
  };
  const read = async (...args: string[]) => {
    const result = await cli("result", [key, ...args, "--json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout!);
  };
  /** The merge thread is spawned once the pipeline reaches merging. */
  const merging = async () => vi.waitFor(async () => {
    const pass = (await store.getReview(key))?.reviewPass;
    expect(pass?.mergeThreadId).toBeDefined();
    return pass!.mergeThreadId!;
  });
  const finish = (passId: string, threadId: string, findings: unknown[] = [], outcome = "complete") => harness.behavior.callAgentTool(
    "finish_review_pass", { passId, summary: "Reviewed the changes.", findings, outcome }, { threadId },
  );
  return { cli, update, read, merging, finish, folder, store, send, spawn, statuses, passes };
}

test("a pass merges in a fresh hidden thread, records findings with ids, and tells only its subscribers", async () => {
  const s = await setup();
  const first = await s.update("--notify");
  expect(first).toMatchObject({ review: key, head: `diff:${first.diffHash}` });
  expect(await s.update()).toEqual({ ...first, reused: true });
  const thread = await s.merging();
  expect(s.spawn).toHaveBeenCalledTimes(1);
  expect(s.spawn.mock.calls[0]![0]).toMatchObject({ visibility: "hidden", permissionMode: "auto" });
  expect(await s.read()).toMatchObject({ passId: first.passId, state: "pending", stage: "merging" });
  // Only the pass's own merge thread records it.
  expect(toolFailed(await s.finish(first.passId, "assistant", [finding]))).toBe(true);
  expect(toolFailed(await s.finish(first.passId, thread, [finding]))).toBe(false);
  await s.passes.settled();
  expect(await s.read(first.passId)).toEqual({ review: key, passId: first.passId, head: first.head, diffHash: first.diffHash, state: "complete", summary: "Reviewed the changes.",
    findings: [{ id: `${first.passId}:1`, ...finding }] });
  expect(toolFailed(await s.finish(first.passId, thread))).toBe(true);
  // One receipt, to the subscriber, without the finding.
  expect(s.send.mock.calls.map(([request]) => request.threadId)).toEqual([owner]);
  expect(s.send.mock.calls[0]![0].input[0]!.text).toContain(`bb review result ${key} ${first.passId}`);
  expect(s.send.mock.calls[0]![0].input[0]!.text).not.toContain(finding.body);
  expect((await s.store.getDraft(key)).comments).toEqual([]);

  // The folder changes: the pass is stale, and the next one starts fresh, seeded with the earlier findings.
  s.folder.files[0]!.body = "@@ -1 +1 @@\n-a\n+fixed\n";
  await s.store.setLifecycle(key, { feature: { ...(await s.store.getReview(key))!.feature!, guideOlderThanDiff: null } });
  expect(await s.read(first.passId)).toMatchObject({ state: "stale" });
});

test("the next pass on a new diff gets a new thread seeded with history, and an empty complete pass is clean", async () => {
  const s = await setup();
  const first = await s.update();
  await s.finish(first.passId, await s.merging(), [finding]);
  await s.passes.settled();
  // The reviewer's own open comment stays a finding until they resolve it.
  await s.store.upsertDraftComment(key, { file: "src/app.ts", line: 1, side: "RIGHT", body: "Rename this.", severity: "nit" });
  const second = await s.update();
  expect(second.passId).not.toBe(first.passId);
  const thread = await s.merging();
  expect(thread).toBe("pass-2");
  const prompt = s.spawn.mock.calls[1]![0].prompt;
  expect(prompt).toContain(finding.body);
  expect(prompt).toContain(first.passId);
  await s.finish(second.passId, thread, []);
  await s.passes.settled();
  expect(await s.read()).toMatchObject({ state: "complete", findings: [{ id: `${second.passId}:1`, source: "draft", body: "Rename this.", severity: "nit" }] });
  expect((await s.store.getReview(key))?.passThreads).toEqual(["pass-1", "pass-2"]);
});

test("incomplete, failed and replaced passes are never clean", async () => {
  const s = await setup();
  const first = await s.update();
  await s.finish(first.passId, await s.merging(), [], "incomplete");
  await s.passes.settled();
  expect(await s.read()).toMatchObject({ state: "incomplete", findings: [] });

  // A merge thread that goes idle twice without recording fails the pass.
  const second = await s.update();
  const thread = await s.merging();
  s.statuses.set(thread, "idle");
  await s.passes.settled();
  expect(await s.read()).toMatchObject({ passId: second.passId, state: "failed", error: expect.stringContaining("without recording") });

  // --retry (round start) replaces a pending pass on the same diff.
  const pending = JSON.parse((await s.cli("round", ["start", key])).stdout!);
  const retried = JSON.parse((await s.cli("round", ["start", key, "--retry"])).stdout!);
  expect(retried.passId).not.toBe(pending.passId);
  expect(toolFailed(await s.finish(pending.passId, "pass-3"))).toBe(true);
  expect(JSON.parse((await s.cli("round", ["result", key, retried.passId])).stdout!)).toMatchObject({ state: "pending" });
  // The diff changing under a pending pass makes it stale, and its result isn't recorded.
  const thread2 = await vi.waitFor(async () => {
    const pass = (await s.store.getReview(key))?.reviewPass;
    expect(pass?.id === retried.passId && pass?.mergeThreadId).toBeTruthy();
    return pass!.mergeThreadId!;
  });
  await s.store.savePatch(key, "a different diff is in the review now");
  expect(await s.read()).toMatchObject({ state: "stale" });
  expect(toolFailed(await s.finish(retried.passId, thread2))).toBe(true);
});

test("usage and refusals", async () => {
  const s = await setup();
  expect((await s.cli("update", [])).exitCode).toBe(2);
  expect((await s.cli("update", [key, "--notify"], null)).exitCode).toBe(1);
  expect((await s.cli("update", [key], "assistant")).exitCode).toBe(2);
  expect((await s.cli("result", [key])).stderr).toContain("no pass yet");
  expect((await s.cli("update", ["nope"])).stderr).toContain("No review nope");
});
