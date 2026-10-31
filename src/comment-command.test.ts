import { expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { targetKey } from "./targets";
import { runGh } from "./gh";
import { getConversation, newConversation } from "./agent";
import { FORMER_WORKERS_KEPT, formerWorkerReview, recordFormerWorker } from "./former-workers";
import type { AsyncStore } from "./store-queue";
import { testStore } from "./test-store.test-support";
import { runCommentCommand } from "./comment-command";
import { runSummaryCommand } from "./summary-command";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn() }));

const key = targetKey({ kind: "pr", number: 7, repo: "acme/web" });
const url = "https://github.com/acme/web/pull/7";
const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep();\n-old();\n+next();\n";

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: key, kind: "pr", number: 7, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  await store.savePatch(key, patch);
  const cli = (...argv: string[]) => harness.behavior.runCli(["comment", ...argv]);
  return { bb, harness, store, cli };
}

test("bb review comment adds, lists, edits, and deletes local draft comments, and never calls GitHub", async () => {
  const { harness, store, cli } = await host();
  expect(await cli("add", url, "a.ts:2", "--code", "next();", "--body", "Why rename?\nIt breaks callers.")).toMatchObject({ exitCode: 0, stdout: "Added a draft comment on a.ts:2. It stays in bb until the reviewer submits the review." });
  expect(await cli("add", key, "a.ts:2", "--side", "left", "--code", "old();", "--body", "Was this used?")).toMatchObject({ exitCode: 0 });
  await store.upsertDraftComment(key, { file: "a.ts", line: 1, side: "RIGHT", body: "Reviewer's own" });

  expect((await cli("list", url)).stdout).toBe([
    "3 draft comments:",
    "a.ts:2 RIGHT · added by an agent\n  Why rename?\n  It breaks callers.",
    "a.ts:2 LEFT · added by an agent\n  Was this used?",
    "a.ts:1 RIGHT · added by the reviewer\n  Reviewer's own",
  ].join("\n"));
  expect(JSON.parse((await cli("list", url, "--json")).stdout).comments[2]).toEqual({ file: "a.ts", line: 1, side: "RIGHT", author: "reviewer", severity: "none", body: "Reviewer's own", stale: false });

  expect(await cli("edit", url, "a.ts:2", "--body", "Reworded")).toMatchObject({ exitCode: 0, stdout: "Updated the draft comment on a.ts:2." });
  expect(await cli("delete", url, "a.ts:2", "--side", "LEFT")).toMatchObject({ exitCode: 0, stdout: "Deleted the draft comment on a.ts:2 (LEFT side)." });
  expect((await store.getDraft(key)).comments.map((c) => [c.line, c.side, c.author ?? "reviewer", c.body])).toEqual([
    [2, "RIGHT", "agent", "Reworded"], [1, "RIGHT", "reviewer", "Reviewer's own"],
  ]);
  // An open panel refreshes after each change.
  expect(harness.inspection.realtimeSignals.filter((signal) => signal.channel === `draft:${key}`)).toHaveLength(4);
  expect(runGh).not.toHaveBeenCalled();
});

test("bb review comment and summary find a renamed repository's review by the URL bb review list prints for it (bug bash CLI-2)", async () => {
  const { harness, store, cli } = await host();
  // As the sync leaves it: the old name and key, the PR's new URL.
  await store.saveReview({ ...(await store.getReview(key))!, url: "https://github.com/acme/site/pull/7" });
  for (const review of ["https://github.com/Acme/Site/pull/7/files", "acme/site#7"]) {
    expect(JSON.parse((await cli("list", review, "--json")).stdout).review, review).toBe(key);
    expect(await harness.behavior.runCli(["summary", review]), review).toMatchObject({ exitCode: 0 });
  }
  expect(await cli("list", "https://github.com/acme/site/pull/8")).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("No saved review for") });
});

test("while a review's first guide is written, comment and summary say the draft waits for it, not that it's being regenerated (bug bash CLI-1)", async () => {
  const { harness, store, cli } = await host();
  await store.saveReview({ ...(await store.getReview(key))!, status: "generating" });
  const building = "The guide is still being written, and the draft waits for it. Run `bb review list` until it says guide ready, then try again.";
  expect(await cli("add", url, "a.ts:2", "--code", "next();", "--body", "Callers still use old().")).toMatchObject({ exitCode: 1, stderr: building });
  expect(await harness.behavior.runCli(["summary", url, "--body", "One question."])).toMatchObject({ exitCode: 1, stderr: building });
  // Usage mistakes still say what's wrong, and listing works.
  expect(await cli("add", url, "a.ts:2", "--body", "x")).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("add needs --code") });
  expect(await cli("list", url)).toMatchObject({ exitCode: 0 });
  await store.savePreferences({ ...(await store.getPreferences()).preferences, knobs: { ...(await store.getPreferences()).preferences.knobs, reviewCommandInThreads: false } }, (await store.getPreferences()).revision);
  expect(await cli("delete", url, "a.ts:2")).toMatchObject({ exitCode: 1, stderr: "The guide is still being written, and the draft waits for it. Wait until it's ready, then try again." });
  // A rebuild, with the guide kept, is still one.
  await store.saveGuide(key, { title: "G", intent: "I", sections: [], unplacedFiles: [] });
  expect(await cli("add", url, "a.ts:2", "--code", "next();", "--body", "x")).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("being regenerated") });
  expect(await store.getDraft(key)).toMatchObject({ body: "", comments: [] });
  // The skill says so, rather than that nothing waits for the guide.
  const skill = readFileSync(new URL("../skills/code-review-workspace/SKILL.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  expect(skill).toContain("you needn't wait for it, but comments and the summary do: run `bb review list` until the review says guide ready.");
});

test("bb review comment and summary ask bb what names a review by its id outside the store's lock, so other store calls don't wait on bb", async () => {
  const commands = [(store: AsyncStore, bb: Parameters<typeof runCommentCommand>[1]) => runCommentCommand(store, bb, ["list", "web#7"], () => {}),
    (store: AsyncStore, bb: Parameters<typeof runSummaryCommand>[1]) => runSummaryCommand(store, bb, ["web#7"], () => {})];
  for (const command of commands) {
    const { bb, harness, store } = await host();
    // A local review, whose id needs bb's projects.
    await store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "main...feature", cwd: "/repo", status: "ready", createdAt: 1 });
    let answer!: () => void;
    harness.inspection.sdk.stub("projects.list", () => new Promise((resolve) => { answer = () => resolve([]); }));
    const ran = command(store, bb);
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("projects.list")).toHaveLength(1));
    expect(await Promise.race([store.exclusive(async () => "free"), new Promise((resolve) => setTimeout(() => resolve("held"), 200))])).toBe("free");
    answer();
    expect(await ran).toMatchObject({ exitCode: 0 });
  }
});

test("the comment usage BB shows agents, and the skill, name the options add and edit take (bug bash CLI-10, DOC-7)", async () => {
  const { harness } = await host();
  const usage = harness.inspection.registrations.cli!.commands!.find((command) => command.name === "comment")!.usage;
  const skill = readFileSync(new URL("../skills/code-review-workspace/SKILL.md", import.meta.url), "utf8");
  for (const option of ["--side", "--code", "--body", "--severity", "--evidence", "--pre-existing"]) {
    expect(usage, option).toContain(`[${option}`);
    expect(skill, option).toContain(`\`${option}`);
  }
  // The review sends comments back to the main thread (src/loop.ts) while Settings lets it (bug bash CLI-9).
  expect(skill.replace(/\s+/g, " ")).toContain("The reviewer can send their comments back here, each with an id, while **Send comments to the main thread** is on in Settings.");
});

test("bb review comment changes an agent's comments but not the reviewer's", async () => {
  const { store, cli } = await host();
  await store.upsertDraftComment(key, { file: "a.ts", line: 1, side: "RIGHT", body: "Reviewer's own" });
  const refused = { exitCode: 1, stderr: "The reviewer wrote this comment. Suggest the change in chat; they can ask on the comment to have you apply it. Nothing was changed." };
  expect(await cli("edit", url, "a.ts:1", "--body", "Reworded")).toMatchObject(refused);
  expect(await cli("delete", url, "a.ts:1")).toMatchObject(refused);
  expect((await store.getDraft(key)).comments).toEqual([{ file: "a.ts", line: 1, side: "RIGHT", body: "Reviewer's own" }]);
});

test("bb review comment explains refusals and usage mistakes", async () => {
  const { store, cli } = await host();
  expect(await cli("add", url, "a.ts:1", "--code", "next();", "--body", "x")).toMatchObject({ exitCode: 1, stderr: "Line 1 on the RIGHT side of a.ts is `keep();`. The code you sent is on line 2. Nothing was added." });
  expect(await cli("edit", url, "a.ts:9", "--body", "x")).toMatchObject({ exitCode: 1, stderr: "There's no draft comment on a.ts:9." });
  expect(await cli("list", "https://github.com/acme/web/pull/8")).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("No saved review for") });
  for (const argv of [[], ["move", url], ["add", url, "a.ts:2", "--body", "x"], ["edit", url, "a.ts:2"], ["edit", url, "a.ts:2", "--body", "  "],
    ["delete", url, "a.ts"], ["delete", url, "a.ts:2", "--side", "UP"], ["delete", url, "a.ts:2", "--body", "x"], ["list", url, "--json", "--json"], ["add", url, "a.ts:2", "--code"]]) {
    expect({ argv, ...(await cli(...argv)) }).toMatchObject({ argv, exitCode: 2, stderr: expect.stringContaining("usage: bb review comment") });
  }
  expect((await store.getDraft(key)).comments).toEqual([]);
  expect(await cli("--help")).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("Nothing is posted to GitHub") });
  expect(await cli("add", "--help")).toMatchObject({ exitCode: 0 });
});

test("bb review comment keeps how the agent checked a comment with --evidence", async () => {
  const { store, cli } = await host();
  expect(await cli("add", url, "a.ts:2", "--code", "next();", "--body", "Callers still use old().", "--evidence", "grep finds old() in b.ts:4.")).toMatchObject({ exitCode: 0 });
  expect((await store.getDraft(key)).comments[0].evidence).toBe("grep finds old() in b.ts:4.");
  expect(await cli("edit", url, "a.ts:2", "--body", "b.ts still calls old().")).toMatchObject({ exitCode: 0 });
  expect((await store.getDraft(key)).comments[0].evidence).toBe("grep finds old() in b.ts:4.");
  expect(await cli("edit", url, "a.ts:2", "--body", "b.ts still calls old().", "--evidence", "Read b.ts:4.")).toMatchObject({ exitCode: 0 });
  expect((await store.getDraft(key)).comments[0].evidence).toBe("Read b.ts:4.");
  expect(await cli("add", url, "a.ts:1", "--code", "keep();", "--body", "x", "--evidence", "x".repeat(601))).toMatchObject({ exitCode: 2, stderr: expect.stringMatching(/^--evidence is limited to 600 characters\./) });
  expect(await cli("delete", url, "a.ts:2", "--evidence", "x")).toMatchObject({ exitCode: 2, stderr: expect.stringMatching(/^delete doesn't take --evidence/) });
});

test("bb review comment sets a comment's severity with --severity or a label, and lists it", async () => {
  const { store, cli } = await host();
  expect(await cli("add", url, "a.ts:2", "--code", "next();", "--severity", "Should-fix", "--body", "Rename it back.")).toMatchObject({ exitCode: 0 });
  expect(await cli("add", url, "a.ts:2", "--side", "LEFT", "--code", "old();", "--body", "**Question:** Was this used?")).toMatchObject({ exitCode: 0 });
  expect((await store.getDraft(key)).comments.map((c) => [c.severity, c.body])).toEqual([["should-fix", "Rename it back."], ["question", "Was this used?"]]);
  expect((await cli("list", url)).stdout).toContain("a.ts:2 RIGHT · added by an agent · should-fix\n  Rename it back.");
  expect(JSON.parse((await cli("list", url, "--json")).stdout).comments[1].severity).toBe("question");
  expect(await cli("edit", url, "a.ts:2", "--body", "Rename it back, please.")).toMatchObject({ exitCode: 0 });
  expect((await store.getDraft(key)).comments[0]).toMatchObject({ severity: "should-fix", body: "Rename it back, please." });
  expect(await cli("edit", url, "a.ts:2", "--severity", "none", "--body", "Rename it back, please.")).toMatchObject({ exitCode: 0 });
  expect((await store.getDraft(key)).comments[0]).not.toHaveProperty("severity");
  expect(await cli("add", url, "a.ts:1", "--code", "keep();", "--severity", "major", "--body", "x")).toMatchObject({ exitCode: 2, stderr: expect.stringMatching(/^--severity is blocking, should-fix, question, nit, or none\./) });
  expect(await cli("delete", url, "a.ts:2", "--severity", "nit")).toMatchObject({ exitCode: 2, stderr: expect.stringMatching(/^delete doesn't take --severity/) });
});

test("a review's own agent can't change another review through bb review; an ordinary thread still can", async () => {
  const { harness, store } = await host();
  const other = targetKey({ kind: "pr", number: 8, repo: "acme/web" });
  await store.saveReview({ targetKey: other, kind: "pr", number: 8, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  await store.savePatch(other, patch);
  await store.setAssistantThread(key, "assistant-7");
  const as = (threadId: string, ...argv: string[]) => harness.behavior.runCli(argv, { threadId, projectId: "p1" });
  const refused = { exitCode: 2, stderr: "This agent can change only its own review." };
  expect(await as("assistant-7", "comment", "add", other, "a.ts:2", "--code", "next();", "--body", "injected")).toMatchObject(refused);
  expect(await as("assistant-7", "comment", "list", "https://github.com/acme/web/pull/8")).toMatchObject(refused);
  expect(await as("assistant-7", "summary", other, "--body", "injected")).toMatchObject(refused);
  expect(await as("assistant-7", "https://github.com/acme/web/pull/8")).toMatchObject(refused);
  expect(await store.getDraft(other)).toMatchObject({ body: "", comments: [] });
  expect(runGh).not.toHaveBeenCalled();
  // Its own review, and an ordinary thread on any review.
  expect(await as("assistant-7", "comment", "add", url, "a.ts:2", "--code", "next();", "--body", "Mine")).toMatchObject({ exitCode: 0 });
  expect(await as("ordinary", "comment", "add", other, "a.ts:2", "--code", "next();", "--body", "Theirs")).toMatchObject({ exitCode: 0 });
  expect(await as("ordinary", "summary", other, "--body", "Theirs too")).toMatchObject({ exitCode: 0 });
  expect(await store.getDraft(other)).toMatchObject({ body: "Theirs too", comments: [{ body: "Theirs" }] });
});

test("bb review from a review's own agent rebuilds its guide without approving agents on the PR's head", async () => {
  const { harness, store } = await host();
  await store.setAssistantThread(key, "assistant-7");
  vi.mocked(runGh).mockImplementation(async (args: string[]) =>
    args[1] === "view" ? { code: 0, stderr: "", stdout: JSON.stringify({ number: 7, headRefOid: "sha2", title: "Fix", body: "", author: { login: "a" }, baseRefName: "main", headRefName: "f", url }) }
    : args[1] === "diff" ? { code: 0, stderr: "", stdout: patch.replace("next", "later") }
    : args[1] === "graphql" ? { code: 0, stderr: "", stdout: JSON.stringify({ data: { viewer: { login: "me" }, repository: { pullRequest: { author: { login: "a" }, authorAssociation: "MEMBER", isCrossRepository: false } } } }) }
    : { code: 0, stderr: "", stdout: "" });
  expect(await harness.behavior.runCli([url], { threadId: "assistant-7", projectId: "p1" })).toMatchObject({ exitCode: 0 });
  expect((await store.getReview(key))?.headSha).toBe("sha2");
  expect((await store.getReview(key))?.approvedHead).toBeUndefined();
  // Your own bb review on a member's PR approves the head it starts the guide on.
  await store.saveReview({ ...(await store.getReview(key))!, status: "ready", headSha: "sha1" });
  expect(await harness.behavior.runCli([url], { threadId: "ordinary", projectId: "p1" })).toMatchObject({ exitCode: 0 });
  expect((await store.getReview(key))?.approvedHead).toBe("sha2");
});

/** A second review, PR 8, and gh answering for its new head sha2. */
async function otherReview(store: AsyncStore) {
  const other = targetKey({ kind: "pr", number: 8, repo: "acme/web" });
  await store.saveReview({ targetKey: other, kind: "pr", number: 8, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  await store.savePatch(other, patch);
  vi.mocked(runGh).mockImplementation(async (args: string[]) => {
    const number = Number(args[2]);
    return args[1] === "view" ? { code: 0, stderr: "", stdout: JSON.stringify({ number, headRefOid: "sha2", title: "Fix", body: "", author: { login: "a" }, baseRefName: "main", headRefName: "f", url: `https://github.com/acme/web/pull/${number}` }) }
      : args[1] === "diff" ? { code: 0, stderr: "", stdout: patch.replace("next", "later") }
      : { code: 0, stderr: "", stdout: "" };
  });
  return other;
}

/** Every bb review command `threadId` might run against the review `on`, and whether each was refused. */
async function refusedOn(harness: Awaited<ReturnType<typeof host>>["harness"], threadId: string, on: string, number: number) {
  const as = (...argv: string[]) => harness.behavior.runCli(argv, { threadId, projectId: "p1" });
  const results = [
    await as("comment", "add", on, "a.ts:2", "--code", "next();", "--body", "injected"),
    await as("summary", on, "--body", "injected"),
    await as("list"),
    await as(`https://github.com/acme/web/pull/${number}`),
  ];
  return results.map((result) => result.exitCode === 2 && /only its own review|can't list reviews/.test(result.stderr ?? ""));
}

test("an assistant New conversation replaced can't change another review through bb review, and its own bb review doesn't approve agents", async () => {
  const { harness, store } = await host();
  const other = await otherReview(store);
  await store.setAssistantThread(key, "assistant-7");
  harness.inspection.sdk.stub("threads.archive", async () => ({}));
  // The reviewer clicks New conversation: the thread is archived, not stopped, and no longer the review's assistant.
  expect(await harness.behavior.callRpc("newConversation", { targetKey: key })).toEqual({ ok: true });
  expect(await store.getAssistantThread(key)).toBeNull();
  expect(await refusedOn(harness, "assistant-7", other, 8)).toEqual([true, true, true, true]);
  expect(await store.getDraft(other)).toMatchObject({ body: "", comments: [] });
  expect((await store.getReview(other))?.approvedHead).toBeUndefined();
  // Its own review's bb review rebuilds the guide unattended, and doesn't make the thread the review's source.
  expect(await harness.behavior.runCli([url], { threadId: "assistant-7", projectId: "p1" })).toMatchObject({ exitCode: 0 });
  expect(await store.getReview(key)).toMatchObject({ headSha: "sha2" });
  expect((await store.getReview(key))?.approvedHead).toBeUndefined();
  expect((await store.getReview(key))?.sourceThreadId).toBeUndefined();
});

test("an assistant found archived, or a guide writer a new generation replaced, can change only its own review", async () => {
  const { bb, harness, store } = await host();
  const other = await otherReview(store);
  await store.setAssistantThread(key, "archived-7");
  harness.inspection.sdk.stub("threads.get", async () => ({ archivedAt: 1, deletedAt: null }));
  expect((await getConversation(bb, store, key)).threadId).toBeNull();
  expect(await refusedOn(harness, "archived-7", other, 8)).toEqual([true, true, true, true]);

  const generation = await store.beginGeneration(key);
  await store.setGenerationWorker(key, generation, "writer-7");
  await store.saveReview({ ...(await store.getReview(key))!, status: "ready" });
  // An ordinary thread's bb review rebuilds the guide, with a new writer.
  expect(await harness.behavior.runCli([url], { threadId: "ordinary", projectId: "p1" })).toMatchObject({ exitCode: 0 });
  await vi.waitFor(async () => expect(await store.isCurrentGeneration(key, generation)).toBe(false));
  expect(await refusedOn(harness, "writer-7", other, 8)).toEqual([true, true, true, true]);
  expect(await harness.behavior.runCli(["comment", "add", url, "a.ts:2", "--code", "later();", "--body", "Mine"], { threadId: "writer-7", projectId: "p1" })).toMatchObject({ exitCode: 0 });
});

// A reload deleted an interrupted generation's row before its writer was stopped, and a writer spawned for a generation
// replaced meanwhile had no row at all, so neither was recorded (70-review-correctness #2, 71-review-security F4).
test("a guide writer a reload interrupted, or one whose generation was replaced while it spawned, can change only its own review", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await store.saveReview({ targetKey: key, kind: "pr", number: 7, repo: "acme/web", status: "generating", createdAt: 1, headSha: "sha1" });
  await store.savePatch(key, patch);
  await store.setGenerationWorker(key, await store.beginGeneration(key), "writer-9");
  await plugin(bb);
  const other = await otherReview(store);
  expect(await refusedOn(harness, "writer-9", other, 8)).toEqual([true, true, true, true]);

  await vi.waitFor(async () => expect((await store.getReview(key))?.status).not.toBe("generating"));
  await store.saveReview({ ...(await store.getReview(key))!, status: "ready" });
  harness.inspection.sdk.stub("threads.spawn", async () => { await store.beginGeneration(key); return { id: "writer-raced" }; });
  expect(await harness.behavior.runCli([url], { threadId: "ordinary", projectId: "p1" })).toMatchObject({ exitCode: 0 });
  await vi.waitFor(async () => expect(await formerWorkerReview(bb, "writer-raced")).toBe(key));
  expect(await refusedOn(harness, "writer-raced", other, 8)).toEqual([true, true, true, true]);
});

test("the Suggest instructions worker can't change or list any review through bb review", async () => {
  const { harness, store } = await host();
  const other = await otherReview(store);
  harness.inspection.sdk.stub("projects.list", async () => [{ id: "personal", kind: "personal" }]);
  harness.inspection.sdk.stub("threads.spawn", async () => ({ id: "suggester" }));
  harness.inspection.sdk.stub("threads.wait", () => new Promise(() => {}));
  await store.recordAgentOutcomes(key, [{ repo: "acme/web", file: "a.ts", outcome: "removed", body: "Nit", edited: null }]);
  expect(await harness.behavior.callRpc("suggestAssistantInstructions", null)).toEqual({ ok: true });
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.wait")).toHaveLength(1));
  expect(await refusedOn(harness, "suggester", key, 7)).toEqual([true, true, true, true]);
  expect(await refusedOn(harness, "suggester", other, 8)).toEqual([true, true, true, true]);
  expect((await store.getReview(key))?.approvedHead).toBeUndefined();
});

test("a former agent's record outlives its review, and threads never recorded, such as a Fix thread's, are ordinary", async () => {
  const { bb, harness, store } = await host();
  const other = await otherReview(store);
  await store.setAssistantThread(key, "assistant-7");
  harness.inspection.sdk.stub("threads.archive", async () => ({}));
  await newConversation(bb, store, key);
  await store.deleteReview(key);
  expect(await refusedOn(harness, "assistant-7", other, 8)).toEqual([true, true, true, true]);
  for (const threadId of ["ordinary", "fix-thread"]) expect(await refusedOn(harness, threadId, other, 8)).toEqual([false, false, false, false]);
  // The newest records are kept.
  for (let i = 0; i < FORMER_WORKERS_KEPT; i++) void recordFormerWorker(bb, `old-${i}`, other, "writer");
  expect(await refusedOn(harness, "assistant-7", other, 8)).toEqual([false, false, false, false]);
  expect(await refusedOn(harness, `old-${FORMER_WORKERS_KEPT - 1}`, key, 7)).toEqual([true, true, true, true]);
});

test("bb review comment and bb review summary refuse a --body over 65,000 characters", async () => {
  const { harness, store, cli } = await host();
  const long = "x".repeat(65_001);
  expect(await cli("add", url, "a.ts:2", "--code", "next();", "--body", long)).toMatchObject({ exitCode: 2, stderr: expect.stringMatching(/^--body is limited to 65,000 characters\./) });
  expect(await harness.behavior.runCli(["summary", url, "--body", long])).toMatchObject({ exitCode: 2, stderr: expect.stringMatching(/^--body is limited to 65,000 characters\./) });
  expect(await store.getDraft(key)).toMatchObject({ body: "", comments: [] });
  expect(await cli("add", url, "a.ts:2", "--code", "next();", "--body", "x".repeat(65_000))).toMatchObject({ exitCode: 0 });
});

test("bb review comment marks a problem in code the PR didn't change with --pre-existing, and lists it", async () => {
  const { store, cli } = await host();
  expect(await cli("add", url, "a.ts:2", "--code", "next();", "--body", "old() was never awaited.", "--pre-existing")).toMatchObject({ exitCode: 0 });
  expect((await store.getDraft(key)).comments[0].introduced).toBe(false);
  expect((await cli("list", url)).stdout).toContain("a.ts:2 RIGHT · added by an agent · pre-existing");
  expect(JSON.parse((await cli("list", url, "--json")).stdout).comments[0]).toMatchObject({ introduced: false });
  // Without it, edit keeps the mark.
  expect(await cli("edit", url, "a.ts:2", "--body", "old() is never awaited.")).toMatchObject({ exitCode: 0 });
  expect((await store.getDraft(key)).comments[0]).toMatchObject({ body: "old() is never awaited.", introduced: false });
  expect(await cli("delete", url, "a.ts:2", "--pre-existing")).toMatchObject({ exitCode: 2, stderr: expect.stringMatching(/^delete doesn't take --pre-existing/) });
});
