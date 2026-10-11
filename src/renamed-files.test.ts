import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { toGithubReviewPayload } from "./draft";
import { changedFiles } from "./patch";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn() }));

const patch = [
  "diff --git a/src/old.ts b/src/new.ts", "similarity index 90%", "rename from src/old.ts", "rename to src/new.ts",
  "index 1111111..2222222 100644", "--- a/src/old.ts", "+++ b/src/new.ts", "@@ -1,2 +1,2 @@",
  " const a = 1;", "-const b = 2;", "+const b = 3;", "",
].join("\n");

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  store.savePatch("pr-1", patch);
  store.setAssistantThread("pr-1", "assistant");
  const add = (input: Record<string, unknown>) => harness.behavior.callAgentTool("add_draft_comment", input, { threadId: "assistant" });
  return { store, add };
}

test("a renamed file's comments use its new path, which GitHub resolves at the PR's head", async () => {
  const { store, add } = await host();
  expect(changedFiles(patch)).toEqual(["src/new.ts"]);
  await add({ file: "src/new.ts", line: 2, code: "const b = 3;", body: "Why 3?" });
  expect(toGithubReviewPayload(store.getDraft("pr-1")).comments).toEqual([{ path: "src/new.ts", line: 2, side: "RIGHT", body: "Why 3?" }]);
  expect(store.staleDraftComments("pr-1")).toEqual([]);
});

test("a draft comment, its discussion, and the guide saved under a renamed file's old path follow the file", async () => {
  const { store } = await host();
  const old = { file: "src/old.ts", line: 2, side: "RIGHT" as const };
  store.upsertDraftComment("pr-1", { ...old, body: "Why 3?" });
  store.addDiscussionMessage("pr-1", old, "reviewer", "Is this right?");
  store.saveGuide("pr-1", { title: "t", intent: "i", sections: [{ id: "s", title: "S", overview: "o", diffs: [{ file: "src/old.ts", summary: "s" }] }], unplacedFiles: [] });
  expect(store.getDraft("pr-1").comments).toEqual([{ file: "src/new.ts", line: 2, side: "RIGHT", body: "Why 3?" }]);
  expect(store.staleDraftComments("pr-1")).toEqual([]);
  expect(store.listDiscussions("pr-1").map((d) => d.file)).toEqual(["src/new.ts"]);
  expect(store.getGuide("pr-1")?.sections[0].diffs[0].file).toBe("src/new.ts");
});

test("a discussion without a comment, and a Viewed mark, saved under a renamed file's old path follow the file", async () => {
  const { store } = await host();
  store.addDiscussionMessage("pr-1", { file: "src/old.ts", line: 2, side: "RIGHT" }, "reviewer", "Is this right?");
  store.setFileViewed("pr-1", "src/old.ts", "hash");
  expect(store.listDiscussions("pr-1").map((d) => [d.file, d.waiting])).toEqual([["src/new.ts", true]]);
  expect(store.getFileViews("pr-1").map((v) => v.file)).toEqual(["src/new.ts"]);
  store.unsetFileViewed("pr-1", "src/new.ts");
  expect(store.getFileViews("pr-1")).toEqual([]);
});
