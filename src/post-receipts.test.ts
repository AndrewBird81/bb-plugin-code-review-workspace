// bug bash F1: GitHub took a review or reply, then the store failed before recording it. The page heard a failure,
// kept the draft, and the retry posted it to GitHub a second time.
import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const gh = vi.hoisted(() => ({
  /** Runs as GitHub takes the POST, before gh answers. */
  onPost: async () => {},
  posts: [] as string[][],
}));

vi.mock("./gh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gh")>();
  const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
  return {
    ...actual,
    runGh: async (args: string[]) => {
      if (args[0] === "auth") return ok("test-token");
      if (args[1] === "user") return ok("casey");
      if (args.some((a) => a.includes("/reviews")) || args.some((a) => a.includes("/replies"))) {
        gh.posts.push(args);
        await gh.onPost();
        return ok(JSON.stringify({ node_id: `R${gh.posts.length}`, html_url: `https://github.com/acme/web/pull/1#r${gh.posts.length}`, user: { login: "casey" } }));
      }
      return ok(JSON.stringify({ headRefOid: "sha123", baseRefName: "main" }));
    },
  };
});

import plugin from "../server";
import { pgSql } from "./db/pg";
import { migratePg } from "./db/pg-migrations";
import { testPgOptions, testPgUrl } from "./db/pg-test.test-support";
import { runGh } from "./gh";
import { storeOn } from "./store";
import type { AsyncStore } from "./store-queue";
import { createReviewSubmitter } from "./submit-review";
import { postDraftedReply, postReceipts } from "./post-receipts";
import { testStore } from "./test-store.test-support";
import { faultProxy, host, opened, postgresSettings } from "./pg-faults.test-support";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {}); gh.posts.length = 0; gh.onPost = async () => {}; });

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
  expect(first).toEqual({ ok: false, error: "GitHub has your review (https://github.com/acme/web/pull/1#r1), but it couldn't be recorded here: Connection terminated unexpectedly. Submit again to finish recording it: it won't be posted again." });
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

test("a draft changed since a review GitHub took wasn't recorded is checked again, not taken for the posted one", async () => {
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
  const shown = await store.getDraft("pr-1");
  // The posted comment is recorded and leaves the draft, so the page's two no longer match it.
  expect(await createReviewSubmitter(store, runGh, postReceipts(bb.storage.kv))("pr-1", undefined, "casey", shown.comments, shown)).toMatchObject({ ok: false, error: expect.stringContaining("Your draft comments changed") });
  expect((await store.getDraft("pr-1")).comments.map((c) => c.body)).toEqual(["and this"]);
  expect(gh.posts).toHaveLength(1);
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
    ok: false, error: "GitHub has your reply, but it couldn't be recorded here: Connection terminated unexpectedly. Send again to finish recording it: it won't be posted again.",
  });
  down = false;
  expect(await postDraftedReply(postReceipts(bb.storage.kv), store, "pr-1", "T1", "Fixed?", post)).toEqual({ ok: true });
  expect(posts).toBe(1);
  expect((await store.listReplyDrafts("pr-1")).size).toBe(0);
  // Another reply on the thread posts.
  expect(await postDraftedReply(postReceipts(bb.storage.kv), store, "pr-1", "T1", "Fixed?", post)).toEqual({ ok: true });
  expect(posts).toBe(2);
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
