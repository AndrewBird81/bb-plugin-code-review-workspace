import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { register } from "./rpc-stubs";

const at = { file: "a.ts", line: 1, side: "RIGHT" };
/** A call each method's contract takes, as its page or tool will make it. */
const CALLS: Record<string, unknown> = {
  sendNow: { targetKey: "pr-1", comment: at, letPush: true, force: true },
  resolveComment: { targetKey: "pr-1", ...at, state: "dismissed" },
  reopenComment: { targetKey: "pr-1", ...at },
  checkFixes: { targetKey: "pr-1" },
  rewriteGuide: { targetKey: "pr-1" },
  push: { targetKey: "pr-1", force: true },
  openPr: { targetKey: "pr-1" },
  setMainThread: { targetKey: "pr-1", threadId: "thr_main" },
  setLetPush: { targetKey: "pr-1", letPush: true },
  approveReady: { rows: [{ targetKey: "pr-1", token: "t1" }], alsoHeld: true },
  postPreview: { targetKey: "pr-1", token: "t1" },
};

test("an RPC method whose build hasn't landed takes its contract's input and says it isn't available yet", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  for (const [name, handler] of Object.entries(register().handlers)) {
    await expect((handler as () => Promise<unknown>)(), name).rejects.toThrow(/^.+ isn’t available yet\.$/);
    await expect(harness.behavior.callRpc(name, CALLS[name]), name).rejects.toThrow(/isn’t available yet/);
  }
});
