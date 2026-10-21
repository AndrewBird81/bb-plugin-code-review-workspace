import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { testStore } from "./test-store.test-support";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));

import { startAutomaticReview } from "./agent";

function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: { spawn: async () => ({ id: "worker" }), get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }) },
    projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }) },
  } as any });
  return { bb, harness, store: testStore(bb) };
}
const input = (harness: ReturnType<typeof host>["harness"]) => (harness.inspection.sdk.callsTo("threads.spawn")[0][0] as any).input;

test("the automatic review of your own PR is a self-review that suggests COMMENT", async () => {
  runGh.mockResolvedValue({ stdout: "Alice\n", stderr: "", code: 0 });
  const { bb, harness, store } = host();
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, author: "alice", status: "ready", createdAt: 1, projectId: "p1" });
  await startAutomaticReview(bb, store, "pr-1");
  expect(runGh).toHaveBeenCalledWith(["api", "user", "--jq", ".login"]);
  expect(input(harness)[1]).toMatchObject({ visibility: "agent-only", text: expect.stringMatching(/reviewer's own PR.*self-review.*only a Comment review.*suggest COMMENT.*what to fix before asking for review/s) });
});

test("someone else's PR gets the ordinary automatic review", async () => {
  runGh.mockResolvedValue({ stdout: "me\n", stderr: "", code: 0 });
  const { bb, harness, store } = host();
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, author: "alice", status: "ready", createdAt: 1, projectId: "p1" });
  await store.setLifecycle("pr-1", { authorAssociation: "MEMBER" });
  await startAutomaticReview(bb, store, "pr-1");
  expect(input(harness)).toHaveLength(1);
});
