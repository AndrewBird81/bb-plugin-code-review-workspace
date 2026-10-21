import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { toGithubReviewPayload } from "./draft";
import { changedFiles } from "./patch";
import { queueStore } from "./store-queue";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn() }));

const patch = [
  "diff --git a/src/old.ts b/src/new.ts", "similarity index 90%", "rename from src/old.ts", "rename to src/new.ts",
  "index 1111111..2222222 100644", "--- a/src/old.ts", "+++ b/src/new.ts", "@@ -1,2 +1,2 @@",
  " const a = 1;", "-const b = 2;", "+const b = 3;", "",
].join("\n");

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  await store.savePatch("pr-1", patch);
  await store.setAssistantThread("pr-1", "assistant");
  const add = (input: Record<string, unknown>) => harness.behavior.callAgentTool("add_draft_comment", input, { threadId: "assistant" });
  return { store, add };
}

test("a renamed file's comments use its new path, which GitHub resolves at the PR's head", async () => {
  const { store, add } = await host();
  expect(changedFiles(patch)).toEqual(["src/new.ts"]);
  await add({ file: "src/new.ts", line: 2, code: "const b = 3;", body: "Why 3?" });
  expect(toGithubReviewPayload(await store.getDraft("pr-1")).comments).toEqual([{ path: "src/new.ts", line: 2, side: "RIGHT", body: "Why 3?" }]);
  expect(await store.staleDraftComments("pr-1")).toEqual([]);
});

test("a draft comment, its discussion, and the guide saved under a renamed file's old path follow the file", async () => {
  const { store } = await host();
  const old = { file: "src/old.ts", line: 2, side: "RIGHT" as const };
  await store.upsertDraftComment("pr-1", { ...old, body: "Why 3?" });
  await store.addDiscussionMessage("pr-1", old, "reviewer", "Is this right?");
  await store.saveGuide("pr-1", { title: "t", intent: "i", sections: [{ id: "s", title: "S", overview: "o", diffs: [{ file: "src/old.ts", summary: "s" }] }], unplacedFiles: [] });
  expect((await store.getDraft("pr-1")).comments).toEqual([{ file: "src/new.ts", line: 2, side: "RIGHT", body: "Why 3?" }]);
  expect(await store.staleDraftComments("pr-1")).toEqual([]);
  expect((await store.listDiscussions("pr-1")).map((d) => d.file)).toEqual(["src/new.ts"]);
  expect((await store.getGuide("pr-1"))?.sections[0].diffs[0].file).toBe("src/new.ts");
});

test("a discussion without a comment, and a Viewed mark, saved under a renamed file's old path follow the file", async () => {
  const { store } = await host();
  await store.addDiscussionMessage("pr-1", { file: "src/old.ts", line: 2, side: "RIGHT" }, "reviewer", "Is this right?");
  await store.setFileViewed("pr-1", "src/old.ts", "hash");
  expect((await store.listDiscussions("pr-1")).map((d) => [d.file, d.waiting])).toEqual([["src/new.ts", true]]);
  expect((await store.getFileViews("pr-1")).map((v) => v.file)).toEqual(["src/new.ts"]);
  await store.unsetFileViewed("pr-1", "src/new.ts");
  expect(await store.getFileViews("pr-1")).toEqual([]);
});

test("renames move saved rows once per diff, not on every read", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  await store.savePatch("pr-1", patch);
  await store.upsertDraftComment("pr-1", { file: "src/new.ts", line: 2, side: "RIGHT", body: "Why 3?" });
  const db = bb.storage.database();
  const prepare = vi.spyOn(db, "prepare");
  const updates = () => prepare.mock.calls.filter(([sql]) => /^UPDATE \w+ SET file=/.test(sql)).length;
  await store.getDraft("pr-1");
  const first = updates();
  expect(first).toBeGreaterThan(0);
  await store.getDraft("pr-1");
  await store.listDiscussions("pr-1");
  await store.getFileViews("pr-1");
  expect(updates()).toBe(first);
});

test("moving a renamed file's discussions finds them by an index", () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  queueStore(createStore(bb));
  const plan = bb.storage.database().prepare(`EXPLAIN QUERY PLAN UPDATE discussion_entries SET file=? WHERE target_key=? AND file=?`).all("b", "k", "a") as Array<{ detail: string }>;
  expect(plan.map((row) => row.detail).join("\n")).toMatch(/USING INDEX/);
});

test("a row already at a renamed file's new path keeps it, and its namesake stays at the old path, as UPDATE OR IGNORE left them", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = queueStore(createStore(bb));
  const db = bb.storage.database();
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  // Before the diff showed the rename, both paths had rows: line 2 under each, line 1 only under the old one.
  await store.savePatch("pr-1", [
    "diff --git a/src/old.ts b/src/old.ts", "--- a/src/old.ts", "+++ b/src/old.ts", "@@ -1,2 +1,2 @@", " old one", "-x", "+old two",
    "diff --git a/src/new.ts b/src/new.ts", "--- a/src/new.ts", "+++ b/src/new.ts", "@@ -1,2 +1,2 @@", " new one", "-y", "+new two", "",
  ].join("\n"));
  for (const [file, line] of [["src/old.ts", 1], ["src/old.ts", 2], ["src/new.ts", 2]] as const) {
    await store.upsertDraftComment("pr-1", { file, line, side: "RIGHT", body: `${file}:${line}` });
    await store.addDiscussionMessage("pr-1", { file, line, side: "RIGHT" }, "reviewer", `${file}:${line}`);
    await store.setFileViewed("pr-1", file, `${file} hash`);
  }
  await store.savePatch("pr-1", patch);
  const rows = () => ({
    revisions: db.prepare(`SELECT file, line, code FROM draft_comment_revisions ORDER BY file, line`).all(),
    entries: db.prepare(`SELECT file, line, body FROM discussion_entries ORDER BY id`).all(),
    waits: db.prepare(`SELECT file, line FROM discussion_waits ORDER BY file, line`).all(),
    views: db.prepare(`SELECT file, hash FROM file_views ORDER BY file`).all(),
  });
  // What 1.2.0's statements made of the same rows, rolled back once read.
  db.exec("SAVEPOINT before_rename");
  for (const table of ["draft_comment_revisions", "discussion_entries", "discussion_waits", "file_views"]) {
    db.prepare(`UPDATE OR IGNORE ${table} SET file=? WHERE target_key=? AND file=?`).run("src/new.ts", "pr-1", "src/old.ts");
  }
  const ignored = rows();
  db.exec("ROLLBACK TO SAVEPOINT before_rename; RELEASE SAVEPOINT before_rename");
  expect(rows()).not.toEqual(ignored);
  await store.getFileViews("pr-1");
  expect(rows()).toEqual(ignored);
  expect(rows()).toEqual({
    revisions: [{ file: "src/new.ts", line: 1, code: "old one" }, { file: "src/new.ts", line: 2, code: "new two" }, { file: "src/old.ts", line: 2, code: "old two" }],
    entries: [{ file: "src/new.ts", line: 1, body: "src/old.ts:1" }, { file: "src/new.ts", line: 2, body: "src/old.ts:2" }, { file: "src/new.ts", line: 2, body: "src/new.ts:2" }],
    waits: [{ file: "src/new.ts", line: 1 }, { file: "src/new.ts", line: 2 }, { file: "src/old.ts", line: 2 }],
    views: [{ file: "src/new.ts", hash: "src/new.ts hash" }, { file: "src/old.ts", hash: "src/old.ts hash" }],
  });
});
