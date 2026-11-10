import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { startPlugin } from "./plugin-store.test-support";
import { startFocusRun } from "./focus-run";
import { defaultPreferences } from "./preferences";
import type { FocusFinding } from "./focus-model";

vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});
const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n next\n";
async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: "r", kind: "pr", status: "ready", headSha: "head", createdAt: 1 });
  await store.savePatch("r", patch);
  await store.setAssistantThread("r", "assistant");
  await store.setLifecycle("r", { focusRun: { id: "run", head: "head", startedAt: 1, state: "finding", focuses: [{ focusId: "docs", label: "Docs", state: "running", queuedAt: 1 }] } });
  await store.recordFocusThread({ threadId: "focus", targetKey: "r", runId: "run", focusId: "docs", label: "Docs", createdAt: 1 });
  const call = (name: string, input: unknown, threadId = "assistant") => harness.behavior.callAgentTool(name, input, { threadId });
  const merge = async () => {
    const run = (await store.getReview("r"))!.focusRun!;
    await store.setLifecycle("r", { focusRun: { ...run, state: "merging" } });
  };
  return { bb, harness, store, call, merge };
}
const finding = { file: "a.ts", line: 1, code: "new", severity: "should-fix", body: "Wrong comment", evidence: "a.ts:1 contradicts a.ts:2" };

test("submit validates placement atomically, accepts once, and refuses after the run or from another thread", async () => {
  const s = await setup();
  expect(await s.call("submit_focus_findings", { findings: [{ ...finding, line: 9 }], unchecked: [] }, "focus")).toMatchObject({ isError: true });
  expect(await s.store.focusFindings("r", "run")).toEqual([]);
  expect(await s.call("submit_focus_findings", { findings: [finding], unchecked: ["generated docs"] }, "focus")).not.toHaveProperty("isError", true);
  expect((await s.store.getReview("r"))?.focusRun?.focuses[0]).toMatchObject({ state: "done", findings: 1, unchecked: ["generated docs"] });
  for (const thread of ["focus", "assistant", "unknown"]) expect(await s.call("submit_focus_findings", { findings: [], unchecked: [] }, thread)).toMatchObject({ isError: true });
  await s.harness.lifecycle.dispose();
});

test("keep attributes a new unsent draft, stores its location, and rejects foreign-run ids", async () => {
  const s = await setup();
  await s.call("submit_focus_findings", { findings: [finding], unchecked: [] }, "focus");
  await s.merge();
  const [row] = await s.store.focusFindings("r", "run");
  expect(await s.call("keep_focus_finding", { id: "another-run", body: "x", severity: "nit", evidence: "a.ts:1" })).toMatchObject({ isError: true });
  expect(await s.call("keep_focus_finding", { id: row.id, body: "Confirmed in my own words", severity: "should-fix", evidence: "Read a.ts:1-2" })).not.toHaveProperty("isError", true);
  expect((await s.store.getDraft("r")).comments[0]).toMatchObject({ author: "agent", focus: "Docs", body: "Confirmed in my own words" });
  expect((await s.store.focusFindings("r", "run"))[0]).toMatchObject({ status: "kept", draftFile: "a.ts", draftLine: 1, draftSide: "RIGHT" });
  await s.harness.lifecycle.dispose();
});

test.each([undefined, "LEFT", "LOCAL"] as const)("fold locates an unsent draft by location, side %s, retaining its attribution", async (side) => {
  const s = await setup();
  await s.call("submit_focus_findings", { findings: [finding], unchecked: [] }, "focus");
  await s.merge();
  for (const candidate of ["RIGHT", "LEFT", "LOCAL"] as const) await s.store.upsertDraftComment("r", { file: "a.ts", line: 2, side: candidate, author: "agent", body: `General-${candidate}`, focus: `Earlier-${candidate}` });
  const [row] = await s.store.focusFindings("r", "run");
  expect(await s.call("keep_focus_finding", { id: row.id, body: "Both issues", severity: "should-fix", evidence: "a.ts:1-2", into: { file: "a.ts", line: 2, ...(side ? { side } : {}) } })).not.toHaveProperty("isError", true);
  const comments = (await s.store.getDraft("r")).comments;
  expect(comments.find((comment) => comment.side === (side ?? "RIGHT"))).toMatchObject({ body: "Both issues", focus: `Earlier-${side ?? "RIGHT"}` });
  for (const comment of comments.filter((comment) => comment.side !== (side ?? "RIGHT"))) expect(comment).toMatchObject({ body: `General-${comment.side}`, focus: `Earlier-${comment.side}` });
  expect((await s.store.focusFindings("r", "run"))[0]).toMatchObject({ status: "folded", draftLine: 2, draftSide: side ?? "RIGHT" });
  await s.harness.lifecycle.dispose();
});

test("head changes fail closed for all merge tools; findings remain out of the draft", async () => {
  const s = await setup();
  await s.call("submit_focus_findings", { findings: [finding], unchecked: [] }, "focus");
  await s.merge();
  await s.store.setLifecycle("r", { headSha: "new-head" } as any);
  const [row] = await s.store.focusFindings("r", "run");
  for (const [tool, input] of [["list_focus_findings", {}], ["keep_focus_finding", { id: row.id, body: "x", severity: "nit", evidence: "a.ts:1" }], ["dismiss_focus_finding", { id: row.id, reason: "duplicate", note: "x" }]] as const) {
    expect(await s.call(tool, input)).toMatchObject({ isError: true });
  }
  expect((await s.store.focusFindings("r", "run"))[0]).toMatchObject({ status: "not-checked", reason: "diff changed" });
  expect((await s.store.getDraft("r")).comments).toEqual([]);
  await s.harness.lifecycle.dispose();
});

test("dismiss records the reason; reads fence attacker text; focus threads cannot merge", async () => {
  const s = await setup();
  await s.call("submit_focus_findings", { findings: [finding], unchecked: [] }, "focus");
  await s.merge();
  const [row] = await s.store.focusFindings("r", "run");
  expect(String(await s.call("list_focus_findings", {}))).toContain("untrusted");
  expect(await s.call("dismiss_focus_finding", { id: row.id, reason: "duplicate", note: "Already in the draft" }, "focus")).toMatchObject({ isError: true });
  await s.call("dismiss_focus_finding", { id: row.id, reason: "duplicate", note: "Already in the draft" });
  expect((await s.store.focusFindings("r", "run"))[0]).toMatchObject({ status: "dropped", reason: "duplicate", note: "Already in the draft" });
  await s.harness.lifecycle.dispose();
});

export function staged(overrides: Partial<FocusFinding> = {}): FocusFinding {
  return { ...finding, side: "RIGHT", severity: "should-fix", id: "f", targetKey: "r", runId: "run", focusId: "docs", label: "Docs", status: "found", ...overrides };
}

test("keeping a range preserves its validated first and last lines", async () => {
  const s = await setup();
  await s.call("submit_focus_findings", { findings: [{ ...finding, line: 2, startLine: 1, code: "new\nnext" }], unchecked: [] }, "focus");
  await s.merge();
  const [row] = await s.store.focusFindings("r", "run");
  expect(await s.call("keep_focus_finding", { id: row.id, body: "Confirmed range", severity: "should-fix", evidence: "a.ts:1-2" })).not.toHaveProperty("isError", true);
  expect((await s.store.getDraft("r")).comments[0]).toMatchObject({ line: 2, startLine: 1 });
  await s.harness.lifecycle.dispose();
});

test("the five-Nit cap uses the merge agent's severity, including folds", async () => {
  const s = await setup();
  for (let n = 0; n < 6; n++) await s.store.saveFocusFinding(staged({ id: String(n) }));
  await s.store.upsertDraftComment("r", { file: "a.ts", line: 1, side: "RIGHT", author: "agent", body: "General" });
  await s.merge();
  for (let n = 0; n < 6; n++) {
    const result = await s.call("keep_focus_finding", { id: String(n), body: "Combined", severity: "nit", evidence: "a.ts:1", into: { file: "a.ts", line: 1 } });
    if (n < 5) expect(result).not.toHaveProperty("isError", true);
    else expect(result).toMatchObject({ isError: true });
  }
  await s.harness.lifecycle.dispose();
});

test.each(["no submit", "rejected submit"])("%s: idle twice nudges once, then fails stopped without reporting", async (report) => {
  const idles: Array<() => void> = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: {
      spawn: async () => ({ id: "focus" }), get: async () => ({ status: "active" }),
      wait: async ({ signal }: any) => new Promise<void>((resolve, reject) => { idles.push(resolve); signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }),
      send: async () => ({ delivery: "sent" }), stop: async () => ({ ok: true }),
      archive: async () => ({ ok: true }), delete: async () => ({ ok: true }), list: async () => [],
      interactions: { list: async () => [] }, events: { list: async () => [] },
    },
    providers: { list: async () => [{ id: "codex", capabilities: { permissionModes: ["auto"] } }] },
    projects: { defaultExecutionOptions: async () => ({ providerId: "codex" }) },
  } });
  const store = await startPlugin(bb);
  await store.savePreferences({ ...defaultPreferences, focuses: { ...defaultPreferences.focuses, enabled: true } }, 0);
  await store.saveReview({ targetKey: "r", kind: "pr", status: "ready", headSha: "head", createdAt: 1, projectId: "p" });
  await store.setLifecycle("r", { ownPr: true });
  await store.setAssistantThread("r", "assistant");
  await store.savePatch("r", patch);
  await startFocusRun(bb, store, "r");
  await vi.waitFor(() => expect(idles).toHaveLength(1));
  if (report === "rejected submit") expect(await harness.behavior.callAgentTool("submit_focus_findings", { findings: [{ ...finding, line: 9 }], unchecked: [] }, { threadId: "focus" })).toMatchObject({ isError: true });
  expect(harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
  idles[0]();
  await vi.waitFor(() => expect(idles).toHaveLength(2));
  const sends = () => harness.inspection.sdk.callsTo("threads.send").filter(([args]) => (args as any).threadId === "focus");
  expect(sends()).toHaveLength(1);
  const text = (sends()[0][0] as any).input[0].text;
  expect(text).toContain(report === "rejected submit" ? "Your findings were rejected:" : "Submit your findings with submit_focus_findings.");
  if (report === "rejected submit") expect(text).toContain("Line 9");
  idles[1]();
  await vi.waitFor(async () => expect((await store.getReview("r"))?.focusRun).toMatchObject({ mergeAwaitingTools: true, focuses: [{ state: "failed", error: "stopped without reporting" }] }));
  expect(sends()).toHaveLength(1);
  expect(await store.focusFindings("r", (await store.getReview("r"))!.focusRun!.id)).toEqual([]);
  await harness.lifecycle.dispose();
});
