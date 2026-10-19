import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));

import plugin from "../server";
import { createStore } from "./store";

async function setup() {
  runGh.mockReset();
  // Replies post as the account the page verified, casey, signed in on the server.
  const signedIn = (args: string[]) => args[0] === "auth" ? { code: 0, stdout: "tok\n", stderr: "" } : args[1] === "user" ? { code: 0, stdout: "casey\n", stderr: "" } : null;
  runGh.mockImplementation(async (args: string[]) => signedIn(args) ?? { code: 0, stdout: "{}", stderr: "" });
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, createdAt: 1, status: "ready" });
  const call = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  // The channels published from now on.
  const published = () => { const from = harness.inspection.realtimeSignals.length; return () => harness.inspection.realtimeSignals.slice(from).map((signal) => signal.channel); };
  return { store, call, published, signedIn };
}

test("getReplyDrafts lists the drafted replies on any thread: yours, the agent's, and on someone else's thread", async () => {
  const { store, call } = await setup();
  store.setReplyDraft("pr-1", "PRRT_mine", "Fixed in abc123, thanks.", "agent");
  // saveReplyDraft takes any thread's id, not only your feedback's.
  expect(await call("saveReplyDraft", { targetKey: "pr-1", threadId: "PRRT_bob", body: "Agreed, let's keep it." })).toEqual({ ok: true });
  const { drafts } = await call("getReplyDrafts", { targetKey: "pr-1" });
  expect(drafts).toHaveLength(2);
  expect(drafts).toEqual(expect.arrayContaining([
    { threadId: "PRRT_mine", body: "Fixed in abc123, thanks.", author: "agent", updatedAt: expect.any(Number) },
    { threadId: "PRRT_bob", body: "Agreed, let's keep it.", author: "reviewer", updatedAt: expect.any(Number) },
  ]));
  expect(await call("getReplyDrafts", { targetKey: "pr-2" })).toEqual({ drafts: [] });
});

test("replyToThread with the thread's id clears its drafted reply once the reply posts, and says so", async () => {
  const { store, call, published } = await setup();
  store.setReplyDraft("pr-1", "PRRT_bob", "Agreed", "reviewer");
  store.setReplyDraft("pr-1", "PRRT_other", "Later", "reviewer");
  const channels = published();
  expect(await call("replyToThread", { targetKey: "pr-1", inReplyTo: 11, body: "Agreed", threadId: "PRRT_bob", account: "casey" })).toEqual({ ok: true });
  expect(runGh).toHaveBeenCalledWith(["api", "-X", "POST", "repos/acme/web/pulls/1/comments/11/replies", "--input", "-"], { stdin: JSON.stringify({ body: "Agreed" }), timeoutMs: 0, authToken: "tok" });
  expect([...store.listReplyDrafts("pr-1").keys()]).toEqual(["PRRT_other"]);
  expect(channels()).toContain("feedback:pr-1");
});

test("a reply GitHub refuses keeps the thread's drafted reply", async () => {
  const { store, call, published, signedIn } = await setup();
  store.setReplyDraft("pr-1", "PRRT_bob", "Agreed", "reviewer");
  runGh.mockImplementation(async (args: string[]) => signedIn(args) ?? { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  const channels = published();
  expect(await call("replyToThread", { targetKey: "pr-1", inReplyTo: 11, body: "Agreed", threadId: "PRRT_bob", account: "casey" })).toEqual({ ok: false, error: "Not Found (HTTP 404)" });
  expect(store.listReplyDrafts("pr-1").get("PRRT_bob")?.body).toBe("Agreed");
  expect(channels()).not.toContain("feedback:pr-1");
});

test("replyToThread from pages without the thread's id posts as before and leaves drafted replies alone", async () => {
  const { store, call, published } = await setup();
  store.setReplyDraft("pr-1", "PRRT_bob", "Agreed", "reviewer");
  const channels = published();
  expect(await call("replyToThread", { targetKey: "pr-1", inReplyTo: 11, body: "Agreed", account: "casey" })).toEqual({ ok: true });
  expect(runGh).toHaveBeenCalledWith(["api", "-X", "POST", "repos/acme/web/pulls/1/comments/11/replies", "--input", "-"], { stdin: JSON.stringify({ body: "Agreed" }), timeoutMs: 0, authToken: "tok" });
  expect(store.listReplyDrafts("pr-1").get("PRRT_bob")?.body).toBe("Agreed");
  expect(channels()).not.toContain("feedback:pr-1");
});
