// bug bash F1: GitHub took a review or reply, then the store failed before recording it. The page heard a failure,
// kept the draft, and the retry posted it to GitHub a second time.
import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const gh = vi.hoisted(() => ({
  /** Runs as GitHub takes the POST, before gh answers. */
  onPost: async () => {},
  /** Runs as the plugin reads your threads on a PR, before gh answers. */
  onThreads: async () => {},
  posts: [] as string[][],
  /** What each POST sent. */
  payloads: [] as string[],
  /** The PR's head, as GitHub reports it. */
  head: "sha123",
}));

vi.mock("./gh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gh")>();
  const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
  return {
    ...actual,
    runGh: async (args: string[], options?: { stdin?: string }) => {
      if (args[0] === "auth") return ok("test-token");
      if (args[1] === "user") return ok("casey");
      if (args[1] === "graphql" && args.some((a) => a.includes("reviewThreads"))) {
        await gh.onThreads();
        return ok(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
      }
      if (args.some((a) => a.includes("/reviews")) || args.some((a) => a.includes("/replies"))) {
        gh.posts.push(args);
        gh.payloads.push(options?.stdin ?? "");
        await gh.onPost();
        return ok(JSON.stringify({ node_id: `R${gh.posts.length}`, html_url: `https://github.com/acme/web/pull/1#r${gh.posts.length}`, user: { login: "casey" } }));
      }
      return ok(JSON.stringify({ headRefOid: gh.head, baseRefName: "main" }));
    },
  };
});

import plugin from "../server";
import { pgSql } from "./db/pg";
import { migratePg } from "./db/pg-migrations";
import { testPgOptions, testPgUrl } from "./db/pg-test.test-support";
import { runGh } from "./gh";
import { reanchorDraft, storeOn } from "./store";
import type { AsyncStore } from "./store-queue";
import { createReviewSubmitter } from "./submit-review";
import { postDraftedReply, postReceipts } from "./post-receipts";
import { failingCall, testSql, testStore } from "./test-store.test-support";
import { faultProxy, host, opened, postgresSettings } from "./pg-faults.test-support";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {}); gh.posts.length = 0; gh.payloads.length = 0; gh.onPost = async () => {}; gh.onThreads = async () => {}; gh.head = "sha123"; });

const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n";

/** `store`, refusing every call while `down` is true, as a store whose database went away does. */
function failing(store: AsyncStore, down: () => boolean): AsyncStore {
  return new Proxy(store, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => down() ? Promise.reject(new Error("Connection terminated unexpectedly")) : value.apply(target, args);
    },
  });
}

test("a review GitHub took that the store couldn't record is recorded by the next Submit, after a reload too, without posting it again", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  await store.savePatch("pr-1", PATCH);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "nit" });
  await store.setVerdict("pr-1", "COMMENT", "Looks fine apart from the nit.");
  const { comments, body, verdict } = await store.getDraft("pr-1");
  let down = false;
  gh.onPost = async () => { down = true; };
  const first = await createReviewSubmitter(failing(store, () => down), runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", comments, { body, verdict });
  expect(first).toEqual({ ok: false, error: "GitHub has your review (https://github.com/acme/web/pull/1#r1), but it couldn't be recorded here: Connection terminated unexpectedly. Submit again without changing the draft to finish recording it: it won't be posted again." });
  down = false;
  expect((await store.getDraft("pr-1")).comments).toHaveLength(1);
  // A reload's submitter has only what kv kept.
  const second = await createReviewSubmitter(store, runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", comments, { body, verdict });
  expect(second).toEqual({ ok: true, url: "https://github.com/acme/web/pull/1#r1" });
  expect(gh.posts).toHaveLength(1);
  expect(await store.getDraft("pr-1")).toMatchObject({ comments: [], body: "" });
  expect(await store.getReview("pr-1")).toMatchObject({ submittedVerdict: "COMMENT", submittedReviewId: "R1", submittedAt: expect.any(Number) });
  expect(await bb.storage.kv.list("posted-review:")).toEqual([]);
}, 15_000);

// Review round 2, NIT 1: on the head the review was for, a draft changed since got the generic "Your draft comments
// changed" message, not that GitHub already has the comments it took out.
test("a draft changed since a review GitHub took wasn't recorded is checked again, not taken for the posted one, and the Submit that takes out the posted comments says so", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  await store.savePatch("pr-1", PATCH);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "nit" });
  const posted = await store.getDraft("pr-1");
  let down = false;
  gh.onPost = async () => { down = true; };
  expect(await createReviewSubmitter(failing(store, () => down), runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", posted.comments, posted)).toMatchObject({ ok: false });
  down = false;
  gh.onPost = async () => {};
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "and this" });
  const submit = async () => { const shown = await store.getDraft("pr-1"); return createReviewSubmitter(store, runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", shown.comments, shown); };
  // The posted comment is recorded and leaves the draft, and nothing is posted.
  expect(await submit()).toEqual({ ok: false, error: "GitHub already has 1 of these comments, from your review of sha123 (https://github.com/acme/web/pull/1#r1), so it was taken out of your draft. Check the draft, then submit again." });
  expect((await store.getDraft("pr-1")).comments.map((c) => c.body)).toEqual(["and this"]);
  expect(gh.posts).toHaveLength(1);
  expect(await submit()).toEqual({ ok: true, url: "https://github.com/acme/web/pull/1#r2" });
  expect(gh.payloads.map((p) => JSON.parse(p).comments.map((c: { body: string }) => c.body))).toEqual([["nit"], ["and this"]]);
}, 15_000);

// Review round 3, NIT A: on the head the review was for, a Submit whose record took out only the summary GitHub has
// said the generic "Your review summary or verdict changed", not that GitHub already has it.
test("a Submit whose record takes only the summary GitHub has out of the draft says so and posts nothing", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  await store.savePatch("pr-1", PATCH);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "nit" });
  await store.setVerdict("pr-1", "COMMENT", "A nit.");
  const posted = await store.getDraft("pr-1");
  let down = false;
  gh.onPost = async () => { down = true; };
  expect(await createReviewSubmitter(failing(store, () => down), runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", posted.comments, posted)).toMatchObject({ ok: false });
  down = false;
  gh.onPost = async () => {};
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "nit, please" });
  const submit = async () => { const shown = await store.getDraft("pr-1"); return createReviewSubmitter(store, runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", shown.comments, shown); };
  expect(await submit()).toEqual({ ok: false, error: "GitHub already has your summary and verdict, from your review of sha123 (https://github.com/acme/web/pull/1#r1), so they were taken out of your draft. Check the draft, then submit again." });
  expect(gh.posts).toHaveLength(1);
  expect(await store.getDraft("pr-1")).toMatchObject({ comments: [{ body: "nit, please" }], body: "", verdict: "COMMENT" });
  expect(await submit()).toEqual({ ok: true, url: "https://github.com/acme/web/pull/1#r2" });
  expect(gh.payloads.map((p) => JSON.parse(p).comments.map((c: { body: string }) => c.body))).toEqual([["nit"], ["nit, please"]]);
}, 15_000);

test("a Submit of comments edited since a review GitHub took with no summary wasn't recorded posts them", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  await store.savePatch("pr-1", PATCH);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "nit" });
  const posted = await store.getDraft("pr-1");
  let down = false;
  gh.onPost = async () => { down = true; };
  expect(await createReviewSubmitter(failing(store, () => down), runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", posted.comments, posted)).toMatchObject({ ok: false });
  down = false;
  gh.onPost = async () => {};
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "nit, please" });
  const shown = await store.getDraft("pr-1");
  expect(await createReviewSubmitter(store, runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", shown.comments, shown)).toEqual({ ok: true, url: "https://github.com/acme/web/pull/1#r2" });
  expect(gh.posts).toHaveLength(2);
}, 15_000);

test("a reply GitHub took whose draft the store couldn't clear is finished by the next Send of it, after a reload too, without posting it again", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1 });
  await store.setReplyDraft("pr-1", "T1", "Fixed?", "reviewer");
  let down = false;
  let posts = 0;
  const post = async () => { posts++; down = true; return { ok: true as const }; };
  expect(await postDraftedReply(postReceipts(bb.storage.kv), failing(store, () => down), "pr-1", "T1", "Fixed?", post)).toEqual({
    ok: false, error: "GitHub has your reply, but it couldn't be recorded here: Connection terminated unexpectedly. Send again without changing the draft to finish recording it: it won't be posted again.",
  });
  down = false;
  expect(await postDraftedReply(postReceipts(bb.storage.kv), store, "pr-1", "T1", "Fixed?", post)).toEqual({ ok: true });
  expect(posts).toBe(1);
  expect((await store.listReplyDrafts("pr-1")).size).toBe(0);
  // For 15 minutes, a Send of the same text, from a page that gave up waiting on the first or a deliberate repeat, isn't
  // posted: it says GitHub already has it, and leaves its draft to change.
  await store.setReplyDraft("pr-1", "T1", "Fixed?", "reviewer");
  expect(await postDraftedReply(postReceipts(bb.storage.kv), store, "pr-1", "T1", "Fixed?", post)).toEqual({ ok: true, alreadyPosted: true });
  expect(posts).toBe(1);
  expect((await store.listReplyDrafts("pr-1")).size).toBe(1);
  // Other text posts; so does the same text, after that.
  expect(await postDraftedReply(postReceipts(bb.storage.kv), store, "pr-1", "T1", "Fixed, thanks", post)).toEqual({ ok: true });
  expect(posts).toBe(2);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect(await postDraftedReply(postReceipts(bb.storage.kv), store, "pr-1", "T1", "Fixed, thanks", post)).toEqual({ ok: true });
    expect(posts).toBe(3);
  } finally { vi.useRealTimers(); }
}, 15_000);

// Review round 1, BLOCKING 2: a record that saved the submitted state but failed to clear the draft was taken for
// finished, so the next Submit dropped the receipt and left the draft, which the Submit after it posted again.
test("a review whose record saved the submitted state but not the cleared draft is finished by the next Submit, and never posted twice", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  await store.savePatch("pr-1", PATCH);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "nit" });
  await store.setVerdict("pr-1", "COMMENT", "A nit.");
  const shown = await store.getDraft("pr-1");
  const submit = (on: AsyncStore) => createReviewSubmitter(on, runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", shown.comments, shown);
  const halfRecorded = failingCall(store, "clearSubmittedDraft");
  for (let attempt = 0; attempt < 2; attempt++) expect(await submit(halfRecorded)).toMatchObject({ ok: false, error: expect.stringContaining("GitHub has your review") });
  expect(await store.getReview("pr-1")).toMatchObject({ submittedReviewId: "R1" });
  expect(await submit(store)).toEqual({ ok: true, url: "https://github.com/acme/web/pull/1#r1" });
  expect(await store.getDraft("pr-1")).toMatchObject({ comments: [], body: "" });
  expect(await submit(store)).toMatchObject({ ok: false, error: expect.stringContaining("Draft changed · review it") });
  expect(gh.posts).toHaveLength(1);
}, 15_000);

/** The review rebuilt for the PR's new head, `head`, as Update does: the draft stays. */
async function rebuilt(store: AsyncStore, head: string) {
  await store.saveReview({ ...(await store.getReview("pr-1"))!, headSha: head });
  gh.head = head;
}

// Review round 1, BLOCKING 1: a receipt Submit never came back for outlived the diff it was for, and the same approval
// of the new head returned the old review's link without posting.
test("a review GitHub took on an earlier head doesn't stop the same approval of the new head from posting", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  await store.savePatch("pr-1", PATCH);
  await store.setVerdict("pr-1", "APPROVE");
  const approval = { body: "", verdict: "APPROVE" as const };
  let down = false;
  gh.onPost = async () => { down = true; };
  expect(await createReviewSubmitter(failing(store, () => down), runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", [], approval)).toMatchObject({ ok: false });
  down = false;
  gh.onPost = async () => {};
  await rebuilt(store, "sha456");
  expect(await createReviewSubmitter(store, runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", [], approval)).toEqual({ ok: true, url: "https://github.com/acme/web/pull/1#r2" });
  expect(gh.posts).toHaveLength(2);
  expect(gh.payloads.map((p) => JSON.parse(p).commit_id)).toEqual(["sha123", "sha456"]);
  expect(await store.getReview("pr-1")).toMatchObject({ submittedVerdict: "APPROVE", submittedHeadSha: "sha456", submittedReviewId: "R2" });
  expect(await bb.storage.kv.list("posted-review:")).toEqual([]);
}, 15_000);

test("comments GitHub took on an earlier head leave the draft, and the Submit that takes them out says so and posts nothing", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  await store.savePatch("pr-1", PATCH);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "nit" });
  await store.setVerdict("pr-1", "COMMENT", "A nit.");
  const posted = await store.getDraft("pr-1");
  let down = false;
  gh.onPost = async () => { down = true; };
  expect(await createReviewSubmitter(failing(store, () => down), runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", posted.comments, posted)).toMatchObject({ ok: false });
  down = false;
  gh.onPost = async () => {};
  await rebuilt(store, "sha456");
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "and this" });
  const submit = async () => { const shown = await store.getDraft("pr-1"); return createReviewSubmitter(store, runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", shown.comments, shown); };
  expect(await submit()).toEqual({ ok: false, error: "GitHub already has 1 of these comments, from your review of sha123 (https://github.com/acme/web/pull/1#r1), so it was taken out of your draft. Check the draft, then submit again." });
  expect(gh.posts).toHaveLength(1);
  expect(await store.getDraft("pr-1")).toMatchObject({ comments: [{ body: "and this" }], body: "A nit.", verdict: "COMMENT" });
  expect(await submit()).toEqual({ ok: true, url: "https://github.com/acme/web/pull/1#r2" });
  expect(gh.payloads.map((p) => JSON.parse(p).comments.map((c: { body: string }) => c.body))).toEqual([["nit"], ["and this"]]);
}, 15_000);

// Review round 2, NIT 2: a file renamed in the new commits moved the posted comment to its new path, where the match
// that takes posted comments out of the draft missed it, so it stayed in the draft to be posted again.
test("a comment GitHub took on an earlier head leaves the draft though the new commits renamed its file", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  const before = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n one\n+two\n";
  const renamed = "diff --git a/a.ts b/b.ts\nsimilarity index 90%\nrename from a.ts\nrename to b.ts\n--- a/a.ts\n+++ b/b.ts\n@@ -1 +1,2 @@\n one\n+two\n";
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  await store.savePatch("pr-1", before);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "nit" });
  await store.setVerdict("pr-1", "COMMENT", "A nit.");
  const posted = await store.getDraft("pr-1");
  let down = false;
  gh.onPost = async () => { down = true; };
  expect(await createReviewSubmitter(failing(store, () => down), runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", posted.comments, posted)).toMatchObject({ ok: false });
  down = false;
  gh.onPost = async () => {};
  // Rebuilt for the new head as rebuildReview does: the comment follows its line into the new diff.
  await store.savePatch("pr-1", renamed);
  await rebuilt(store, "sha456");
  await store.rebaseDraftComments("pr-1", await reanchorDraft(store, "pr-1", before, renamed));
  const shown = await store.getDraft("pr-1");
  expect(shown.comments).toMatchObject([{ file: "b.ts", line: 2, body: "nit" }]);
  expect(await createReviewSubmitter(store, runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", shown.comments, shown)).toEqual({ ok: false, error: "GitHub already has 1 of these comments, from your review of sha123 (https://github.com/acme/web/pull/1#r1), so it was taken out of your draft. Check the draft, then submit again." });
  expect(gh.posts).toHaveLength(1);
  expect(await store.getDraft("pr-1")).toMatchObject({ comments: [], body: "A nit." });
}, 15_000);

/** Has `event` on `table` fail, on either backend, as on a dropped connection; the returned function undoes it. */
async function refuse(sql: ReturnType<typeof testSql>, event: "INSERT" | "DELETE", table: string): Promise<() => Promise<void>> {
  const name = `refuse_${event.toLowerCase()}_${table}`;
  if (sql.dialect === "sqlite") {
    await sql.run(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'Connection terminated unexpectedly'); END`);
    return async () => { await sql.run(`DROP TRIGGER ${name}`); };
  }
  await sql.run(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Connection terminated unexpectedly'; END $$`);
  await sql.run(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  return async () => { await sql.run(`DROP TRIGGER ${name} ON ${table}`); };
}

/** The plugin serving pr-1, with a reply GitHub took on thread T1 whose draft couldn't be cleared. */
async function replyNotRecorded(body: string) {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  const call = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  const send = () => call("replyToThread", { targetKey: "pr-1", inReplyTo: 11, body, threadId: "T1", account: "casey" });
  expect(await call("saveReplyDraft", { targetKey: "pr-1", threadId: "T1", body })).toEqual({ ok: true });
  const allow = await refuse(testSql(bb), "DELETE", "reply_drafts");
  expect(await send()).toMatchObject({ ok: false, error: expect.stringContaining("GitHub has your reply") });
  await allow();
  expect(gh.posts).toHaveLength(1);
  return { bb, call, send };
}

test("a reply GitHub took whose draft is discarded doesn't stop the same text, drafted and sent again, from posting", async () => {
  const { call, send } = await replyNotRecorded("Thanks!");
  expect(await call("discardReplyDraft", { targetKey: "pr-1", threadId: "T1" })).toEqual({ ok: true });
  expect(await call("saveReplyDraft", { targetKey: "pr-1", threadId: "T1", body: "Thanks!" })).toEqual({ ok: true });
  expect(await send()).toEqual({ ok: true });
  expect(gh.posts).toHaveLength(2);
}, 15_000);

test("a reply GitHub took is forgotten once its draft is saved with other text or cleared, and kept while it's saved unchanged", async () => {
  for (const [saved, kept] of [["Thanks!", true], ["Thanks, fixed.", false], ["", false]] as const) {
    const { bb, call } = await replyNotRecorded("Thanks!");
    expect(await call("saveReplyDraft", { targetKey: "pr-1", threadId: "T1", body: saved })).toEqual({ ok: true });
    expect((await bb.storage.kv.list("posted-reply:")).length).toBe(kept ? 1 : 0);
    gh.posts.length = 0;
  }
}, 30_000);

// Review round 2, BLOCKING: Send posts the reply trimmed, and the page saves the draft it failed to send as typed, so
// a trailing newline, or \r\n for \n, dropped the receipt and the next Send posted the reply again.
test("a reply GitHub took is kept while its draft is saved differing only in line endings or the whitespace around it, and never posted twice", async () => {
  for (const [sent, saved] of [["Thanks!", "Thanks!\n"], ["Thanks!\r\nCasey", "Thanks!\nCasey\r\n"], ["Thanks!\nCasey", "  Thanks!\r\nCasey"]] as const) {
    const { bb, call } = await replyNotRecorded(sent);
    expect(await call("saveReplyDraft", { targetKey: "pr-1", threadId: "T1", body: saved })).toEqual({ ok: true });
    expect((await bb.storage.kv.list("posted-reply:")).length).toBe(1);
    // The page sends the saved draft trimmed.
    expect(await call("replyToThread", { targetKey: "pr-1", inReplyTo: 11, body: saved.trim(), threadId: "T1", account: "casey" })).toEqual({ ok: true });
    expect(gh.posts).toHaveLength(1);
    gh.posts.length = 0;
  }
}, 45_000);

// Review round 3, NIT C: two Sends of one reply at once, from two tabs, both found no receipt and both posted.
test("a second Send of a reply while the first is still sending is refused, and the reply is posted once", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  const call = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  const send = () => call("replyToThread", { targetKey: "pr-1", inReplyTo: 11, body: "Thanks!", threadId: "T1", account: "casey" });
  expect(await call("saveReplyDraft", { targetKey: "pr-1", threadId: "T1", body: "Thanks!" })).toEqual({ ok: true });
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  // GitHub holds the first POST's answer until the second Send is done.
  gh.onPost = async () => { if (gh.posts.length === 1) await answered; };
  const first = send();
  await vi.waitFor(() => { expect(gh.posts).toHaveLength(1); });
  expect(await send()).toEqual({ ok: false, error: "This reply is already being sent." });
  answer();
  expect(await first).toEqual({ ok: true });
  expect(gh.posts).toHaveLength(1);
  expect((await store.listReplyDrafts("pr-1")).size).toBe(0);
});

test("a review GitHub took is recorded, not posted again, when its summary and comments are saved differing only in line endings or the whitespace around them", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  await store.savePatch("pr-1", PATCH);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "A nit:\r\nrename it." });
  await store.setVerdict("pr-1", "COMMENT", "Looks fine\napart from the nit.");
  const posted = await store.getDraft("pr-1");
  let down = false;
  gh.onPost = async () => { down = true; };
  expect(await createReviewSubmitter(failing(store, () => down), runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", posted.comments, posted)).toMatchObject({ ok: false });
  down = false;
  gh.onPost = async () => {};
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "A nit:\nrename it.\n" });
  await store.setVerdict("pr-1", "COMMENT", "Looks fine\r\napart from the nit.\n");
  const shown = await store.getDraft("pr-1");
  expect(await createReviewSubmitter(store, runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", shown.comments, shown)).toEqual({ ok: true, url: "https://github.com/acme/web/pull/1#r1" });
  expect(gh.posts).toHaveLength(1);
  expect(await store.getDraft("pr-1")).toMatchObject({ comments: [], body: "" });
}, 15_000);

// The receipt is kept in memory only when kv refuses it, and a reload would forget it: every message about it says so.
test("a receipt kv refused is kept in memory, and each failed record of it says not to reload, until it's recorded", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  vi.spyOn(bb.storage.kv, "set").mockRejectedValue(new Error("kv is unavailable"));
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  await store.savePatch("pr-1", PATCH);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "nit" });
  await store.setReplyDraft("pr-1", "T1", "Fixed?", "reviewer");
  const { comments, body, verdict } = await store.getDraft("pr-1");
  const receipts = postReceipts(bb.storage.kv);
  let down = false;
  gh.onPost = async () => { down = true; };
  const submit = () => createReviewSubmitter(failing(store, () => down), runGh, receipts)("pr-1", undefined, "casey", comments, { body, verdict });
  const unsaved = " Until then, don't reload the plugin, which would forget it was posted.";
  for (let attempt = 0; attempt < 2; attempt++) expect((await submit()).error).toMatch(new RegExp(`^GitHub has your review .*${unsaved}$`));
  let replies = 0;
  const post = async () => { replies++; down = true; return { ok: true as const }; };
  const send = () => postDraftedReply(receipts, failing(store, () => down), "pr-1", "T1", "Fixed?", post);
  for (let attempt = 0; attempt < 2; attempt++) expect(await send()).toEqual({ ok: false, error: expect.stringMatching(new RegExp(`^GitHub has your reply, .*${unsaved}$`)) });
  down = false;
  expect(await submit()).toEqual({ ok: true, url: "https://github.com/acme/web/pull/1#r1" });
  expect(await send()).toEqual({ ok: true });
  expect(gh.posts).toHaveLength(1);
  expect(replies).toBe(1);
}, 20_000);

// Review round 2, NIT 3: a receipt kv couldn't read was taken for none, so Submit or Send posted what GitHub may have.
test("Submit and Send refuse, posting nothing, while kv can't say whether GitHub already has the review or reply", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  await store.savePatch("pr-1", PATCH);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "nit" });
  const shown = await store.getDraft("pr-1");
  const call = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  expect(await call("saveReplyDraft", { targetKey: "pr-1", threadId: "T1", body: "Thanks!" })).toEqual({ ok: true });
  vi.spyOn(bb.storage.kv, "get").mockRejectedValue(new Error("kv is unavailable"));
  const unchecked = { ok: false, error: "Couldn't check whether GitHub already has this; try again." };
  expect(await createReviewSubmitter(store, runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", shown.comments, shown)).toEqual(unchecked);
  expect(await call("replyToThread", { targetKey: "pr-1", inReplyTo: 11, body: "Thanks!", threadId: "T1", account: "casey" })).toEqual(unchecked);
  expect(gh.posts).toHaveLength(0);
  expect((await store.getDraft("pr-1")).comments).toHaveLength(1);
  expect([...(await store.listReplyDrafts("pr-1")).keys()]).toEqual(["T1"]);
  // Saving the reply draft still saves it.
  expect(await call("saveReplyDraft", { targetKey: "pr-1", threadId: "T1", body: "Thanks, fixed." })).toEqual({ ok: true });
  expect((await store.listReplyDrafts("pr-1")).get("T1")).toMatchObject({ body: "Thanks, fixed." });
});

// Review round 3, NIT B: GitHub took the review and it was recorded, then saving what Submit keeps of it failed, so the
// page heard a failure.
test("a Submit GitHub took and recorded says so though saving the diff it reviewed fails, and doesn't post again", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha123" });
  await store.savePatch("pr-1", PATCH);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "nit" });
  await store.setVerdict("pr-1", "COMMENT", "A nit.");
  const { comments, body, verdict } = await store.getDraft("pr-1");
  const call = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  const { revision } = await call("getReviewBundle", { targetKey: "pr-1" });
  await refuse(testSql(bb), "INSERT", "review_snapshots");
  const submit = () => call("submitReview", { targetKey: "pr-1", revision, account: "casey", comments, body, verdict });
  expect(await submit()).toEqual({ ok: true, url: "https://github.com/acme/web/pull/1#r1" });
  expect(await store.getDraft("pr-1")).toMatchObject({ comments: [], body: "" });
  expect(await submit()).toMatchObject({ ok: false });
  expect(gh.posts).toHaveLength(1);
}, 15_000);

async function servedThroughProxy() {
  const proxy = await faultProxy();
  cleanup.push(() => proxy.close());
  const { schema, settings } = postgresSettings(proxy.port);
  const seeding = pgSql(testPgOptions(schema));
  cleanup.push(async () => {
    const admin = pgSql(testPgOptions("public"));
    await admin.run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  cleanup.push(() => seeding.end());
  await migratePg(seeding, schema);
  const seed = storeOn(seeding);
  await seed.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", headSha: "sha123", base: "main", status: "ready", createdAt: 1 });
  await seed.savePatch("pr-1", PATCH);
  const { bb, harness } = await host(settings);
  await plugin(bb);
  harness.behavior.runService("storage");
  await opened(harness);
  let current = harness;
  cleanup.push(() => current.lifecycle.dispose());
  /** A plugin reload, which forgets whatever the instance before kept in memory. */
  const reload = async () => {
    current = (await current.lifecycle.reload(plugin)).harness;
    current.behavior.runService("storage");
    await opened(current);
  };
  const call = (method: string, input: unknown) => current.behavior.callRpc(method, input);
  return { proxy, call, reload, seed };
}

describe.skipIf(!testPgUrl)("on Postgres, through a proxy that goes down as GitHub takes the post", () => {
  test("submitReview: a reload, then Submit again, records the review GitHub took and doesn't post it again", async () => {
    const { proxy, call, reload, seed } = await servedThroughProxy();
    let { revision } = await call("getReviewBundle", { targetKey: "pr-1" }) as { revision: string };
    await call("saveDraftComment", { targetKey: "pr-1", revision, comment: { file: "a.ts", line: 1, side: "RIGHT", body: "nit" } });
    await call("saveSummary", { targetKey: "pr-1", revision, body: "Looks fine apart from the nit." });
    await call("setVerdict", { targetKey: "pr-1", revision, verdict: "COMMENT" });
    const page = async () => { const { comments, body, verdict } = await seed.getDraft("pr-1"); return { comments, body, verdict }; };
    const shown = await page();

    gh.onPost = () => proxy.mode("down");
    const first = await call("submitReview", { targetKey: "pr-1", revision, account: "casey", ...shown }) as { ok: boolean; error?: string };
    gh.onPost = async () => {};
    await proxy.mode("forward");
    expect(first).toMatchObject({ ok: false, error: expect.stringContaining("GitHub has your review (https://github.com/acme/web/pull/1#r1), but it couldn't be recorded here") });
    expect(first.error).toContain("it won't be posted again");
    expect((await seed.getDraft("pr-1")).comments).toHaveLength(1);

    await reload();
    ({ revision } = await call("getReviewBundle", { targetKey: "pr-1" }) as { revision: string });
    expect(await call("submitReview", { targetKey: "pr-1", revision, account: "casey", ...await page() })).toEqual({ ok: true, url: "https://github.com/acme/web/pull/1#r1" });
    expect(gh.posts).toHaveLength(1);
    expect((await seed.getDraft("pr-1")).comments).toEqual([]);
    expect(await seed.getReview("pr-1")).toMatchObject({ submittedReviewId: "R1", submittedAt: expect.any(Number) });
  }, 60_000);

  test("replyToFeedback: a reload, then Send again, clears the reply draft GitHub took and doesn't post it again", async () => {
    const { proxy, call, reload, seed } = await servedThroughProxy();
    await seed.saveFeedbackThreads("pr-1", [{
      id: "T1", commentId: 11, reviewId: null, path: "a.ts", line: 1, originalLine: 1, startLine: null, side: "RIGHT", subjectType: "LINE",
      body: "nit", createdAt: 1, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open", replyAt: null,
    }], null);
    await seed.setReplyDraft("pr-1", "T1", "Fixed in the next push?", "reviewer");
    gh.onPost = () => proxy.mode("down");
    const first = await call("replyToFeedback", { targetKey: "pr-1", threadId: "T1", body: "Fixed in the next push?", account: "casey" });
    gh.onPost = async () => {};
    await proxy.mode("forward");
    expect(first).toMatchObject({ ok: false, error: expect.stringContaining("GitHub has your reply, but it couldn't be recorded here") });
    expect([...(await seed.listReplyDrafts("pr-1")).keys()]).toEqual(["T1"]);
    await reload();
    expect(await call("replyToFeedback", { targetKey: "pr-1", threadId: "T1", body: "Fixed in the next push?", account: "casey" })).toMatchObject({ ok: true });
    expect(gh.posts).toHaveLength(1);
    expect((await seed.listReplyDrafts("pr-1")).size).toBe(0);
  }, 60_000);

  // Review round 3, BLOCKING 1: after GitHub took the reply and its draft was cleared, the store went down while the
  // plugin read your threads again, so reading the feedback to return failed the Send, the page saved the reply as its
  // draft again, and the next Send posted it a second time.
  test("replyToFeedback: a Send GitHub took says so though the store goes down as it reads your threads again", async () => {
    const { proxy, call, seed } = await servedThroughProxy();
    await seed.setLifecycle("pr-1", { submittedAt: 1, submittedHeadSha: "sha123", submittedVerdict: "COMMENT" });
    await seed.saveFeedbackThreads("pr-1", [{
      id: "T1", commentId: 11, reviewId: null, path: "a.ts", line: 1, originalLine: 1, startLine: null, side: "RIGHT", subjectType: "LINE",
      body: "nit", createdAt: 1, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open", replyAt: null,
    }], null);
    await seed.setReplyDraft("pr-1", "T1", "Fixed in the next push?", "reviewer");
    gh.onPost = async () => { gh.onThreads = () => proxy.mode("down"); };
    const sent = await call("replyToFeedback", { targetKey: "pr-1", threadId: "T1", body: "Fixed in the next push?", account: "casey" });
    gh.onThreads = async () => {};
    await proxy.mode("forward");
    expect(sent).toEqual({ ok: true });
    expect(gh.posts).toHaveLength(1);
    expect((await seed.listReplyDrafts("pr-1")).size).toBe(0);
  }, 60_000);

  test("replyToThread: a reload, then Send again, clears the reply draft GitHub took and doesn't post it again", async () => {
    const { proxy, call, reload, seed } = await servedThroughProxy();
    await seed.setReplyDraft("pr-1", "T1", "Agreed", "reviewer");
    gh.onPost = () => proxy.mode("down");
    const first = await call("replyToThread", { targetKey: "pr-1", inReplyTo: 11, body: "Agreed", threadId: "T1", account: "casey" });
    gh.onPost = async () => {};
    await proxy.mode("forward");
    expect(first).toMatchObject({ ok: false, error: expect.stringContaining("GitHub has your reply") });
    await reload();
    expect(await call("replyToThread", { targetKey: "pr-1", inReplyTo: 11, body: "Agreed", threadId: "T1", account: "casey" })).toEqual({ ok: true });
    expect(gh.posts).toHaveLength(1);
    expect((await seed.listReplyDrafts("pr-1")).size).toBe(0);
  }, 60_000);
});
