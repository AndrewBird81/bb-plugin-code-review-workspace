// bug bash D1, D3, D4: Postgres's text can't hold U+0000, which SQLite kept. git shows a file as text when its first
// 8,000 bytes hold no NUL, so a NUL further in reaches a diff, and an agent's or a reviewer's text can carry one. Both
// backends store U+FFFD in its place, so they keep the same text and no write fails on Postgres alone.
import { expect, test, vi } from "vitest";
import { testStore } from "./test-store.test-support";

const NUL_DIFF = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n x\n+nul\u0000here\n";
const STORED_DIFF = NUL_DIFF.replace("\u0000", "\uFFFD");

vi.mock("./gh", async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    runGh: vi.fn(async (args: string[]) => {
      if (args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 7, title: "Fix the thing", body: "b", author: { login: "a" }, baseRefName: "main", headRefName: "f",
            url: "https://github.com/acme/web/pull/7", headRefOid: "abc123",
          }),
          stderr: "", code: 0,
        };
      }
      if (args[1] === "diff") return { stdout: NUL_DIFF, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }),
    // git diff in a local review's checkout.
    runGit: vi.fn(async () => ({ stdout: NUL_DIFF, stderr: "", code: 0 })),
  };
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPrReview } from "./start-review";
import { localDiffChanged, rerunReview } from "./rereview";
import * as gh from "./gh";
import { targetKey } from "./targets";
import { addComment } from "./draft-comments";
import { noteReviewerRemoval, noteReviewerSave, recordOutcomes } from "./learning";

const key = targetKey({ kind: "pr", number: 7, repo: "acme/web" });
const threads = { spawn: async () => ({ id: "th_1" }), wait: async () => {}, archive: async () => {}, stop: async () => {} };

test("a PR whose diff holds a NUL character starts its review, with U+FFFD in its place", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads } as never });
  const store = testStore(bb);
  expect(await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" })).toEqual({ ok: true, targetKey: key });
  expect(await store.patch(key)).toBe(STORED_DIFF);
  await store.dispose();
});

test("a local review rebuilds for a new diff that holds a NUL character, which then counts as its diff, not a change", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads } as never });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "ref-abc", kind: "ref", status: "ready", createdAt: 1, projectId: "p1", gitRef: "main...feature", cwd: process.cwd() });
  await store.savePatch("ref-abc", "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-o\n+x\n");
  expect(await rerunReview({ bb, store, gh }, "ref-abc")).toEqual({ ok: true });
  expect(await store.patch("ref-abc")).toBe(STORED_DIFF);
  // Rebuilt, it isn't rebuilt again for the same diff.
  expect(await localDiffChanged({ store, gh }, { ...(await store.getReview("ref-abc"))!, status: "ready" })).toBe(false);
  await store.dispose();
});

const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n one\n+two\n";
const at = { file: "a.ts", line: 2, side: "RIGHT" as const };
const BODY = "The fixture has a stray \u0000 byte here.";

async function reviewWithAgentComment() {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1 });
  await store.savePatch("pr-1", PATCH);
  expect(await addComment(store, "pr-1", { ...at, code: "two", body: BODY })).toMatchObject({ ok: true });
  return store;
}

test("the reviewer can remove an agent's draft comment whose body holds a NUL character", async () => {
  const store = await reviewWithAgentComment();
  // As the removeDraftComment RPC does.
  await store.exclusive(async (tx) => {
    await noteReviewerRemoval(tx, "pr-1", at);
    await tx.deleteDraftComment("pr-1", at);
  });
  expect((await store.getDraft("pr-1")).comments).toEqual([]);
  await store.dispose();
});

test("the reviewer can rewrite an agent's draft comment whose body holds a NUL character", async () => {
  const store = await reviewWithAgentComment();
  // As the saveDraftComment RPC does.
  await store.exclusive(async (tx) => {
    await noteReviewerSave(tx, "pr-1", { ...at, body: "Better words" });
    await tx.upsertDraftComment("pr-1", { ...at, body: "Better words" });
  });
  expect((await store.getDraft("pr-1")).comments[0]?.body).toBe("Better words");
  await store.dispose();
});

test("recording what became of the agent's comments after a submit takes a NUL character in one", async () => {
  const store = await reviewWithAgentComment();
  const draft = await store.getDraft("pr-1");
  // As the submitReview RPC does once GitHub has the review.
  await store.exclusive((tx) => recordOutcomes(tx, "pr-1", draft));
  expect((await store.listAgentOutcomes()).map((o) => o.body)).toEqual(["The fixture has a stray \uFFFD byte here."]);
  await store.dispose();
});

test("free text with a NUL character is kept by every Store write, with U+FFFD in its place", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  const v = "a\u0000b";
  const stored = "a\uFFFDb";
  const where = { file: "a.ts", line: 1, side: "RIGHT" as const };
  await store.saveReview({ targetKey: "pr-1", kind: "pr", status: "ready", createdAt: 1, title: v });
  await store.savePatch("pr-1", v);
  await store.saveSnapshot("pr-1", "sha", v);
  await store.setReviewContext("pr-1", v);
  await store.addDiscussionMessage("pr-1", where, "reviewer", v);
  await store.setReplyDraft("pr-1", "t1", v, "agent");
  await store.saveReviewerNotes("pr-1", v, 0);
  await store.noteAgentCommentChange("pr-1", { ...where, kind: "removed", code: null, body: v, removed: v });
  await store.recordAgentOutcomes("pr-1", [{ repo: "acme/web", file: "a.ts", outcome: "kept", body: v, edited: null }]);
  expect((await store.getReview("pr-1"))?.title).toBe(stored);
  expect(await store.patch("pr-1")).toBe(stored);
  expect(await store.getSnapshot("pr-1", "sha")).toBe(stored);
  expect(await store.getReviewContext("pr-1")).toBe(stored);
  expect((await store.listDiscussions("pr-1"))[0]?.entries[0]?.body).toBe(stored);
  expect((await store.listReplyDrafts("pr-1")).get("t1")?.body).toBe(stored);
  expect((await store.getReviewerNotes("pr-1")).body).toBe(stored);
  expect((await store.listAgentOutcomes())[0]?.body).toBe(stored);
  await store.dispose();
});
