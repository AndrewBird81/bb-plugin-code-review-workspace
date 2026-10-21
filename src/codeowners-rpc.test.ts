import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { testStore } from "./test-store.test-support";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));

import plugin from "../server";

const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
const patch = ["src/api/a.ts", "src/b.ts", "README.md"].map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`).join("");

/** GitHub: CODEOWNERS at the base branch, the PR's context, you, and your teams. */
function github(codeowners: string | null) {
  return vi.fn(async (args: string[]) => {
    if (args[1] === "graphql" && args.some((arg) => arg.includes("CODEOWNERS"))) {
      // GitHub says each place without one isn't found, and gh fails.
      const a = codeowners === null ? null : { object: { text: codeowners } };
      const errors = (codeowners === null ? ["a", "b", "c"] : ["b", "c"]).map((alias) => ({ type: "NOT_FOUND", path: ["repository", "pullRequest", "baseRef", "target", alias] }));
      return { stdout: JSON.stringify({ data: { repository: { pullRequest: { baseRef: { target: { a, b: null, c: null } } } } }, errors }), stderr: "", code: 1 };
    }
    if (args[1] === "graphql") return ok(JSON.stringify({ data: { viewer: { login: "me" }, repository: { pullRequest: { title: "Retry", body: "", author: { login: "alice" }, baseRefName: "main", headRefName: "retry" } } } }));
    if (args.includes("user/teams")) return ok("acme/web-team\n");
    if (args[1] === "user") return ok("me\n");
    return ok("[]");
  });
}

async function setUp(headSha: string) {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, base: "main", headSha, status: "ready", createdAt: 1 });
  await store.savePatch("pr-1", patch);
  await store.setAssistantThread("pr-1", "assistant");
  return harness;
}

test("getCodeOwners gives each changed file its owners and marks the ones you or your teams own", async () => {
  runGh.mockImplementation(github("* @acme/docs\nsrc/ @acme/web-team\nsrc/b.ts @bob\n"));
  const harness = await setUp("owners1");
  expect(await harness.behavior.callRpc("getCodeOwners", { targetKey: "pr-1" })).toEqual({ files: [
    { file: "src/api/a.ts", owners: ["@acme/web-team"], mine: true },
    { file: "src/b.ts", owners: ["@bob"], mine: false },
    { file: "README.md", owners: ["@acme/docs"], mine: false },
  ] });
});

test("getCodeOwners says why it couldn't read CODEOWNERS", async () => {
  runGh.mockImplementation(async () => ({ stdout: "", stderr: "HTTP 502: Bad Gateway", code: 1 }));
  const harness = await setUp("owners2");
  expect(await harness.behavior.callRpc("getCodeOwners", { targetKey: "pr-1" })).toEqual({ files: [], error: expect.stringContaining("HTTP 502") });
});

test("read_pr_context tells the review agent which files the reviewer owns", async () => {
  runGh.mockImplementation(github("src/api/ @me\n"));
  const harness = await setUp("owners3");
  const out: any = await harness.behavior.callAgentTool("read_pr_context", {}, { threadId: "assistant" });
  expect(String(out.content?.[0]?.text ?? out)).toContain("CODEOWNERS: the reviewer owns 1 of the changed files, directly or through a team: src/api/a.ts.");
  // Without CODEOWNERS, nothing about it.
  runGh.mockImplementation(github(null));
  const none: any = await (await setUp("owners4")).behavior.callAgentTool("read_pr_context", {}, { threadId: "assistant" });
  expect(String(none.content?.[0]?.text ?? none)).not.toContain("CODEOWNERS");
});
