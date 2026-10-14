import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));

import plugin from "../server";
import { createStore } from "./store";
import { toolFailed } from "./fake-host.test-support";

test("read_pr_context reads the context of the guide writer's or the assistant's review", async () => {
  runGh.mockImplementation(async (args: string[]) => args[1] === "graphql"
    ? { stdout: JSON.stringify({ data: { viewer: { login: "me" }, repository: { pullRequest: { title: "Retry", body: "Fixes it.", author: { login: "alice" }, baseRefName: "main", headRefName: "retry" } } } }), stderr: "", code: 0 }
    : { stdout: "[]", stderr: "", code: 0 });
  const titles: Record<string, string> = { writer: "Generate guide: pr-1", stranger: "Something else" };
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: { get: async ({ threadId }: { threadId: string }) => ({ title: titles[threadId] ?? null }) } } as any });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, base: "main", headSha: "abc", status: "generating", createdAt: 1 });
  store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n");
  store.setReviewContext("pr-1", "Implements LIN-42.");
  store.setAssistantThread("pr-1", "assistant");
  store.setGenerationWorker("pr-1", store.beginGeneration("pr-1"), "writer");
  const text = (out: any) => String(out.content?.[0]?.text ?? out);
  for (const threadId of ["writer", "assistant"]) {
    const out = await harness.behavior.callAgentTool("read_pr_context", {}, { threadId });
    expect(text(out)).toContain("PR #1 in acme/web, by @alice");
    expect(text(out)).toContain("Implements LIN-42.");
  }
  expect(toolFailed(await harness.behavior.callAgentTool("read_pr_context", {}, { threadId: "stranger" }))).toBe(true);
});
