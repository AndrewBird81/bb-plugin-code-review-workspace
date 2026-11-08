// reviews.v1.status (src/review-status.ts), as another plugin reads it: who each review waits on, whether you've approved
// the code as it is now, since when, and the review that stays of a merge, through the plugin's own flows; and that it
// agrees with the list, which All reviews, the alerts and bb review list read.
import { expect, test, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn(async () => ({ stdout: "", stderr: "no GitHub here", code: 1 })));
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { startPlugin } from "./plugin-store.test-support";
import { folderHost } from "./env-diff.test-support";
import { diffFilesHead } from "./env-diff";
import { featureKey } from "./targets";
import { reviewRevision } from "./review-revision";
import { REVIEW_STATUS, publicContract } from "./public-contract";
import type { AsyncStore } from "./store-queue";

const LINES = ["a", "b", "c"];
const PATCH = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -0,0 +1,3 @@", ...LINES.map((l) => `+const ${l} = 1;`)].join("\n");
const AT = LINES.map((_, i) => ({ file: "src/a.ts", line: i + 1, side: "RIGHT" as const }));

interface Thread { title: string; archivedAt?: number | null; environmentId?: string | null }

/** BB's threads: the main thread `coder` takes what's sent at once, and has asked for nothing else. */
function threadsSdk(threads: Record<string, Thread>) {
  return {
    get: async ({ threadId }: { threadId: string }) => {
      const thread = threads[threadId];
      if (!thread) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
      return { id: threadId, titleFallback: null, archivedAt: null, deletedAt: null, environmentId: null, status: "idle", queuedMessageCount: 0, visibility: "visible", originPluginId: null, parentThreadId: null, ...thread };
    },
    send: async () => ({ ok: true, delivery: "sent" }),
    events: { list: async () => [] },
    queuedMessages: { list: async () => [] },
    experimental_listAncestors: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((id) => ({ threadId: id, ancestorIds: [] })) }),
    list: async () => [],
    experimental_listDescendants: async () => ({ threads: [] }),
    stop: async () => ({}),
  };
}

function host(threads: Record<string, Thread> = { coder: { title: "Retry uploads" } }) {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: threadsSdk(threads),
    projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }) },
  } as any });
  return { bb, harness, threads };
}
type Harness = ReturnType<typeof host>["harness"];

type Row = { targetKey: string; waitsOn: string; waitsOnThreadId: string | null; approved: boolean; since: number; label: string; archived: boolean; mergedInto: string | null } & Record<string, unknown>;
const statuses = async (harness: Harness) => ((await harness.behavior.callRpc(REVIEW_STATUS, null)) as { reviews: Row[] }).reviews;
/** The review's status, once checked against the list: it waits on you just where Needs review has it, as the list labels it. */
async function status(harness: Harness, key: string): Promise<Row> {
  const rows = await statuses(harness);
  const listed = ((await harness.behavior.callRpc("listReviews", null)) as { reviews: Array<{ targetKey: string; turn: { group: string; label: string } }> }).reviews;
  for (const review of listed) {
    const row = rows.find((r) => r.targetKey === review.targetKey)!;
    expect({ key: review.targetKey, user: row.waitsOn === "user", label: row.label }).toEqual({ key: review.targetKey, user: review.turn.group === "needs", label: review.turn.label });
  }
  return rows.find((row) => row.targetKey === key)!;
}
/** Move the review's last Send, or its approval, a minute back, for what happens since to be before now. Returns its time. */
async function backdate(store: AsyncStore, key: string): Promise<number> {
  const review = (await store.getReview(key))!;
  const at = Date.now() - 60_000;
  if (review.approvalSent) await store.setLifecycle(key, { approvalSent: { ...review.approvalSent, at } });
  else await store.setLifecycle(key, { sends: review.sends!.map((send, i) => i === review.sends!.length - 1 ? { ...send, at } : send) });
  return at;
}
const cli = (harness: Harness, threadId: string | undefined, ...argv: string[]) => harness.behavior.runCli(argv, { ...threadId ? { threadId } : {}, projectId: "p1" });

/** A local review of /repo, main...feature, whose main thread is `coder`, with three comments. */
async function local(store: AsyncStore, key = "ref-1") {
  await store.saveReview({ targetKey: key, kind: "ref", gitRef: "main...feature", status: "ready", createdAt: 1_000, projectId: "p1", cwd: "/repo" });
  await store.setLifecycle(key, { sourceThreadId: "coder" });
  await store.savePatch(key, PATCH);
  for (const at of AT) await store.upsertDraftComment(key, { ...at, body: `Fix line ${at.line}.` });
}

/** acme/web#12, yours unless `ownPr` is false, sent to `coder`, with three comments. */
async function pr(store: AsyncStore, over: Record<string, unknown> = {}) {
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 12, url: "https://github.com/acme/web/pull/12", title: "Retry uploads", author: "alice", head: "retry-uploads", headSha: "abc1234def5678", status: "ready", createdAt: 1_000, projectId: "p1" });
  await store.setLifecycle("pr-1", { ownPr: true, sourceThreadId: "coder", sourceThreadAt: 1, latestHeadSha: "abc1234def5678", watchingSince: 1, ...over });
  await store.savePatch("pr-1", PATCH);
  for (const at of AT) await store.upsertDraftComment("pr-1", { ...at, body: `Fix line ${at.line}.` });
}

test("a local review waits on you; on the main thread while it fixes what you sent, idle or not; and on you once it reports them all, runs bb review ready, or is archived or deleted first", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await local(store);
  // 1. Nothing sent.
  expect(await status(h.harness, "ref-1")).toMatchObject({ waitsOn: "user", waitsOnThreadId: null, approved: false, label: "Ready", since: 1_000, archived: false, mergedInto: null });
  // 2. Sent: the main thread is fixing them.
  expect(await h.harness.behavior.callRpc("sendToSourceThread", { targetKey: "ref-1", comments: AT.slice(0, 2) })).toMatchObject({ ok: true, sendN: 1 });
  const sentAt = (await store.getReview("ref-1"))!.sends![0]!.at;
  expect(await status(h.harness, "ref-1")).toMatchObject({ waitsOn: "agent", waitsOnThreadId: "coder", label: "0 of 2 reported", since: sentAt });
  // 5. Idle alone never means done.
  await cli(h.harness, "coder", "report", "c1", "done");
  await h.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "coder" }), lastAssistantText: null });
  expect(await status(h.harness, "ref-1")).toMatchObject({ waitsOn: "agent", label: "1 of 2 reported", since: sentAt });
  // 3. bb review ready: back with you, since then.
  await cli(h.harness, "coder", "ready");
  const readyAt = (await store.getReview("ref-1"))!.sends![0]!.readyAt!;
  expect(await status(h.harness, "ref-1")).toMatchObject({ waitsOn: "user", label: "Ready to re-review", since: readyAt });

  // 3. Every comment reported does the same; 4. archived or deleted first, they're back with you.
  for (const end of ["report", "thread.archived", "thread.deleted"] as const) {
    const other = host();
    const s = await startPlugin(other.bb);
    await local(s);
    await other.harness.behavior.callRpc("sendToSourceThread", { targetKey: "ref-1", comments: AT.slice(0, 2) });
    if (end === "report") {
      await cli(other.harness, "coder", "report", "c1", "done");
      await cli(other.harness, "coder", "report", "c2", "declined", "--note", "Not needed.");
    } else await other.harness.behavior.emitThreadEvent(end, { thread: makeThreadResponse({ id: "coder" }) });
    const send = (await s.getReview("ref-1"))!.sends![0]!;
    expect(await status(other.harness, "ref-1")).toMatchObject({ waitsOn: "user", since: send.readyAt ?? send.stopped!.at });
  }
});

test("comments sent from a PR's review wait on the thread fixing them, on your PR or another's, until something since is yours", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await pr(store);
  expect(await status(h.harness, "pr-1")).toMatchObject({ waitsOn: "user", label: "Your PR", pr: { repo: "acme/web", number: 12, url: "https://github.com/acme/web/pull/12", author: "alice" }, branch: "retry-uploads" });
  // 6. Comments sent to the thread on your own PR, as on a folder's review that became its PR's.
  await h.harness.behavior.callRpc("sendToSourceThread", { targetKey: "pr-1", comments: AT });
  const sentAt = await backdate(store, "pr-1");
  expect(await status(h.harness, "pr-1")).toMatchObject({ waitsOn: "agent", waitsOnThreadId: "coder", label: "0 of 3 reported", since: sentAt });
  // 7. A teammate's comment since the Send is yours, whatever is still out.
  await store.setLifecycle("pr-1", { signals: { newComments: { count: 1, at: sentAt + 1_000, by: "dana" } } });
  expect(await status(h.harness, "pr-1")).toMatchObject({ waitsOn: "user", label: "Your PR · 1 new comment", since: sentAt + 1_000 });

  // Someone else's PR: sent anyway, it waits on the thread too, until a re-request since.
  const other = host();
  const s = await startPlugin(other.bb);
  await pr(s, { ownPr: false, submittedVerdict: "REQUEST_CHANGES", submittedAt: 500, submittedHeadSha: "abc1234def5678", signals: { lastReviewAt: 500, lastReviewSha: "abc1234def5678", threads: { total: 1, resolved: 0, answered: 0, questions: 0, open: 1, outdated: 0 } } });
  // 11. Before the Send it waits on the PR's author.
  expect(await status(other.harness, "pr-1")).toMatchObject({ waitsOn: "author", waitsOnThreadId: null, label: "Changes requested", since: 500 });
  await other.harness.behavior.callRpc("sendToSourceThread", { targetKey: "pr-1", comments: AT, force: true });
  const at = await backdate(s, "pr-1");
  expect(await status(other.harness, "pr-1")).toMatchObject({ waitsOn: "agent", waitsOnThreadId: "coder", since: at });
  const signals = (await s.getReview("pr-1"))!.signals!;
  await s.setLifecycle("pr-1", { signals: { ...signals, requestedAt: at + 1_000, requestedVia: "user", requestPending: true } });
  expect(await status(other.harness, "pr-1")).toMatchObject({ waitsOn: "user", label: "Re-requested", since: at + 1_000 });
});

/** A folder's review of env1 on MaxBook, at feat/qa, its main thread `main` there; `folder` is what bb's Git plugin reads. */
async function folderReview() {
  const BODY = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
  const folder = { files: [{ path: "src/a.ts", body: BODY }] };
  const h = folderHost(folder, { threads: threadsSdk({ main: { title: "Snooze flaky checks", environmentId: "env1" } }) });
  const store = await startPlugin(h.bb);
  const key = featureKey("env1", "feat/qa");
  await store.saveReview({ targetKey: key, kind: "ref", gitRef: "feat/qa", title: "Snooze flaky checks", status: "ready", createdAt: 1_000, projectId: "proj_api" });
  await store.setLifecycle(key, {
    feature: { environmentId: "env1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/src/api", branch: "feat/qa", baseRef: "main", repo: "acme/api" },
    mainThread: { threadId: "main", environmentId: "env1", origin: "adopted", since: 1 }, sourceThreadId: "main",
  });
  await store.savePatch(key, `diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n${BODY}`);
  await store.saveSnapshotFiles(key, diffFilesHead(await store.patchHash(key)), { revisions: { "src/a.ts": "100644:8:100644:46" }, hidden: [] });
  return { ...h, store, key, folder };
}

test("a folder's review approved in its main thread waits on no one, approved, until its folder changes, before Update and after", async () => {
  const f = await folderReview();
  expect(await status(f.harness, f.key)).toMatchObject({ id: "api:feat/qa", folder: { environmentId: "env1" }, branch: "feat/qa", mainThreadId: "main", threadIds: ["main"], pr: null });
  // 8. Approved in the thread.
  expect(await f.harness.behavior.callRpc("sendApprovalToSourceThread", { targetKey: f.key, revision: await reviewRevision(f.store, f.key) })).toMatchObject({ ok: true });
  const approvedAt = (await f.store.getReview(f.key))!.approvalSent!.at;
  expect(await status(f.harness, f.key)).toMatchObject({ waitsOn: "nobody", approved: true, label: "Approved", since: approvedAt });
  // 9. The main thread changes the folder: before Update, the review says so and is yours, since it's seen.
  f.folder.files[0]!.body = "@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n";
  expect(await f.harness.behavior.callRpc("checkFeature", { targetKey: f.key })).toMatchObject({ state: "changed", changedFiles: 1 });
  const before = Date.now();
  const changed = await status(f.harness, f.key);
  expect(changed).toMatchObject({ waitsOn: "user", approved: false, label: "Ready" });
  expect(changed.since).toBeGreaterThanOrEqual(before);
  // Kept: a second read says the same time.
  expect((await status(f.harness, f.key)).since).toBe(changed.since);
  // After Update, the diff you approved is gone, and the approval with it.
  expect(await f.harness.behavior.callRpc("updateFeature", { targetKey: f.key })).toEqual({ ok: true });
  expect((await f.store.getReview(f.key))!.approvalSent).toBeNull();
  expect(await status(f.harness, f.key)).toMatchObject({ waitsOn: "user", approved: false, label: "Ready", since: changed.since });
});

test("your own PR approved in its main thread waits on no one until a teammate's comment since, or its head moves on", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await pr(store);
  for (const at of AT) await store.deleteDraftComment("pr-1", at);
  await h.harness.behavior.callRpc("sendApprovalToSourceThread", { targetKey: "pr-1", revision: await reviewRevision(store, "pr-1") });
  const approvedAt = await backdate(store, "pr-1");
  expect(await status(h.harness, "pr-1")).toMatchObject({ waitsOn: "nobody", approved: true, label: "Approved", since: approvedAt });
  // 10. New comments since: yours, the code still as you approved it.
  await store.setLifecycle("pr-1", { signals: { newComments: { count: 2, at: approvedAt + 1_000, by: "dana" } } });
  expect(await status(h.harness, "pr-1")).toMatchObject({ waitsOn: "user", approved: true, label: "Your PR · 2 new comments", since: approvedAt + 1_000 });
  // New commits: not what you approved.
  await store.setLifecycle("pr-1", { signals: {}, latestHeadSha: "fedcba9876543" });
  expect(await status(h.harness, "pr-1")).toMatchObject({ waitsOn: "user", approved: false, label: "Your PR" });
  // Its guide updated for them, the approval of the diff before goes.
  await store.saveReview({ ...(await store.getReview("pr-1"))!, headSha: "fedcba9876543" });
  expect((await store.getReview("pr-1"))!.approvalSent).toBeNull();
});

test("a Push under way waits on the thread committing and pushing it", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await local(store);
  const push = { at: 5_000, threadId: "coder", repo: "acme/web", head: "feature" };
  // 12. Committing, then pushing.
  await store.setLifecycle("ref-1", { push: { ...push, state: "committing" } });
  expect(await status(h.harness, "ref-1")).toMatchObject({ waitsOn: "agent", waitsOnThreadId: "coder", label: "Committing for Push", since: 5_000 });
  // Told to push the commit it checked: the thread's next step, since then.
  await store.setLifecycle("ref-1", { push: { ...push, state: "pushing", at: 6_000, sha: "c0ffee0" } });
  expect(await status(h.harness, "ref-1")).toMatchObject({ waitsOn: "agent", label: "Pushing", since: 6_000 });
  // Asking you first, it's yours.
  await store.setLifecycle("ref-1", { push: { ...push, state: "mismatch", at: 7_000, warning: "Not pushed." } });
  expect(await status(h.harness, "ref-1")).toMatchObject({ waitsOn: "user", label: "Ready" });
});

test("a draft PR, a snooze, and a folder on another branch or removed wait on no one", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  // 13. A draft PR found on GitHub.
  await store.saveReview({ targetKey: "pr-2", kind: "pr", repo: "acme/web", number: 13, url: "https://github.com/acme/web/pull/13", author: "bob", head: "wip", status: "tracked", createdAt: 1_000 });
  await store.setLifecycle("pr-2", { ownPr: false, signals: { isDraft: true } });
  expect(await status(h.harness, "pr-2")).toMatchObject({ waitsOn: "nobody", approved: false, label: "Draft" });
  // Snoozed.
  await pr(store, { ownPr: false, submittedVerdict: "REQUEST_CHANGES", submittedAt: 500, submittedHeadSha: "abc1234def5678", snoozedAt: 2_000, snoozedUntil: Date.now() + 3_600_000, signals: { lastReviewAt: 500, lastReviewSha: "abc1234def5678" } });
  expect(await status(h.harness, "pr-1")).toMatchObject({ waitsOn: "nobody", label: "Snoozed", since: 2_000 });
  // A folder's review: paused on another branch, then its folder removed.
  const feature = { environmentId: "env1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/src/api", branch: "feat/qa", baseRef: "main", repo: "acme/api" };
  await local(store, "br-1");
  await store.setLifecycle("br-1", { feature: { ...feature, pausedOn: "main" } });
  expect(await status(h.harness, "br-1")).toMatchObject({ waitsOn: "nobody", label: "Paused", folder: { environmentId: "env1" } });
  await store.setLifecycle("br-1", { feature: { ...feature, folderGone: true } });
  expect(await status(h.harness, "br-1")).toMatchObject({ waitsOn: "nobody", label: "Folder removed", folder: null });
});

test("a review merged into another names the one that stays, through every merge, until that one's deleted", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await local(store, "br-1");
  await local(store, "br-2");
  await pr(store);
  // 14. A folder's review merged into its PR's, which then merged on.
  expect(await store.mergeReview("br-1", "br-2")).not.toBeNull();
  expect(await status(h.harness, "br-1")).toMatchObject({ archived: true, waitsOn: "nobody", label: "Merged into another review", mergedInto: "br-2" });
  expect(await status(h.harness, "br-2")).toMatchObject({ archived: false, mergedInto: null });
  expect(await store.mergeReview("br-2", "pr-1")).not.toBeNull();
  expect(await status(h.harness, "br-1")).toMatchObject({ mergedInto: "pr-1" });
  expect(await status(h.harness, "br-2")).toMatchObject({ mergedInto: "pr-1", since: (await store.getReview("br-2"))!.mergedAt });
  await store.deleteReview("pr-1");
  expect((await statuses(h.harness)).map((row) => [row.targetKey, row.mergedInto])).toEqual([["br-1", null], ["br-2", null]]);
});

test("since is kept on the review, here and by the sync's pass over every review, so it holds between reads", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await local(store);
  await store.setLifecycle("ref-1", { approvalSent: { at: 3_000, threadId: "coder", title: "Retry uploads", revision: await reviewRevision(store, "ref-1") } });
  expect(await status(h.harness, "ref-1")).toMatchObject({ waitsOn: "nobody", approved: true, since: 3_000 });
  expect((await store.getReview("ref-1"))!.standing).toEqual({ key: "nobody+approved", at: 3_000 });
  // The sync's pass sees the folder change first: Ready since then, as the next read says.
  await store.setLifecycle("ref-1", { feature: { environmentId: "env1", hostId: "host_max", machine: "MaxBook", path: "/repo", branch: "feature", baseRef: "main", repo: null, changedFiles: 2 } });
  const before = Date.now();
  await h.harness.behavior.callRpc("refreshReviews", { force: false });
  const kept = (await store.getReview("ref-1"))!.standing!;
  expect(kept).toMatchObject({ key: "user" });
  expect(kept.at).toBeGreaterThanOrEqual(before);
  expect(await status(h.harness, "ref-1")).toMatchObject({ waitsOn: "user", since: kept.at });
});

test("an approval of an earlier diff, as one kept from before 1.10.0, ends as the plugin starts", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await local(store);
  await local(store, "ref-2");
  await local(store, "ref-3");
  await store.setLifecycle("ref-1", { approvalSent: { at: 3_000, threadId: "coder", title: null, revision: "an earlier diff" } });
  await store.setLifecycle("ref-2", { approvalSent: { at: 3_000, threadId: "coder", title: null, revision: await reviewRevision(store, "ref-2") } });
  // A diff the prune dropped, which opening the review reads again, is no other.
  await store.setLifecycle("ref-3", { approvalSent: { at: 3_000, threadId: "coder", title: null, revision: await reviewRevision(store, "ref-3") } });
  await store.dropPatch("ref-3");
  expect(await status(h.harness, "ref-1")).toMatchObject({ waitsOn: "nobody", approved: true });
  const service = h.harness.runService("review-state");
  await vi.waitFor(async () => expect((await store.getReview("ref-1"))!.approvalSent).toBeNull());
  service.controller.abort();
  await service.done;
  expect((await store.getReview("ref-2"))!.approvalSent).toMatchObject({ at: 3_000 });
  expect((await store.getReview("ref-3"))!.approvalSent).toMatchObject({ at: 3_000 });
  await store.saveReview({ ...(await store.getReview("ref-3"))!, title: "Renamed upstream" });
  expect((await store.getReview("ref-3"))!.approvalSent).toMatchObject({ at: 3_000 });
  expect(await status(h.harness, "ref-1")).toMatchObject({ waitsOn: "user", approved: false });
});

test("the contract publishes to BB's RPC discovery: its schemas are JSON Schema with local references, and waitsOn has four values", () => {
  for (const method of Object.values(publicContract)) {
    const output = JSON.stringify(method.output["~standard"].jsonSchema!.output({ target: "draft-2020-12" }));
    const input = JSON.stringify(method.input["~standard"].jsonSchema!.input({ target: "draft-2020-12" }));
    expect(output.length + input.length).toBeLessThan(128 * 1024);
    expect(output + input).not.toMatch(/"\$ref":"(?!#)/);
  }
  const method = publicContract[REVIEW_STATUS];
  const output = method.output["~standard"].jsonSchema!.output({ target: "draft-2020-12" }) as any;
  expect(output.properties.reviews.items.properties.waitsOn.enum).toEqual(["user", "agent", "author", "nobody"]);
  expect(method.input["~standard"].validate(null)).toEqual({ value: null });
});

// Plugins call it by this name, with this input, for this answer, as since 1.8.0: what a change here would break.
test("reviewThreadChanges keeps its name, takes { threadId } alone, and answers { ok, error, targetKey }, which may gain fields, as joined has", () => {
  const method = publicContract.reviewThreadChanges;
  const schema = (direction: "input" | "output") => {
    const json = method[direction]["~standard"].jsonSchema![direction]({ target: "draft-2020-12" }) as any;
    return { required: json.required ?? [], properties: Object.fromEntries(Object.entries(json.properties).map(([key, field]: [string, any]) => [key, { type: field.type, ...field.minLength ? { minLength: field.minLength } : {} }])), additionalProperties: json.additionalProperties };
  };
  expect(schema("input")).toEqual({ required: ["threadId"], properties: { threadId: { type: "string", minLength: 1 } }, additionalProperties: false });
  expect(schema("output")).toEqual({ required: ["ok"], properties: { ok: { type: "boolean" }, error: { type: "string" }, targetKey: { type: "string" }, joined: { type: "boolean" } }, additionalProperties: {} });
  const valid = (input: unknown) => !("issues" in (method.input["~standard"].validate(input) as object));
  expect([{ threadId: "thr_1" }, { threadId: "" }, {}, { threadId: "thr_1", force: true }, null].map(valid)).toEqual([true, false, false, false, false]);
});
