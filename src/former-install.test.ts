// Until 1.0.0 the plugin was guided-review, and BB keeps a plugin's database under its id: the first start under the
// new id copies the former install's reviews in, and the former install's agent threads keep their tools.
import { afterEach, test, expect } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { createStore } from "./store";
import plugin from "../server";
import { queueStore } from "./store-queue";

const dataDirs: string[] = [];
const newDataDir = () => { const dir = mkdtempSync(join(tmpdir(), "crw-data-")); dataDirs.push(dir); return dir; };
afterEach(() => { for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A data directory holding a former guided-review install's database, with one review, its draft and assistant. */
async function formerDataDir() {
  const former = createFakePluginHost({ pluginId: "guided-review" });
  const store = queueStore(createStore(former.bb));
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1 });
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "Why?" });
  await store.setAssistantThread("pr-1", "assistant-1");
  const db = former.bb.storage.database();
  const file = db.name;
  db.close();
  const dataDir = newDataDir();
  mkdirSync(join(dataDir, "plugins", "guided-review"), { recursive: true });
  copyFileSync(file, join(dataDir, "plugins", "guided-review", "data.db"));
  return dataDir;
}

test("the first start under the new id brings in the former install's reviews, drafts, and assistants", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace", dataDir: await formerDataDir() });
  const store = queueStore(createStore(bb));
  expect(await store.getReview("pr-1")).toMatchObject({ repo: "acme/web", status: "ready" });
  expect((await store.getDraft("pr-1")).comments).toEqual([expect.objectContaining({ file: "a.ts", line: 2, body: "Why?" })]);
  expect(await store.getAssistantThread("pr-1")).toBe("assistant-1");
  // Its migrations came with it, so a new review still saves.
  await store.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, status: "ready", createdAt: 2 });
  expect((await store.listReviews()).map((review) => review.targetKey)).toEqual(["pr-2", "pr-1"]);
});

test("an install that already has its own data, or is itself guided-review, imports nothing", async () => {
  const dataDir = await formerDataDir();
  const mine = createFakePluginHost({ pluginId: "code-review-workspace", dataDir });
  const store = queueStore(createStore(mine.bb));
  await store.deleteReview("pr-1");
  // A restart opens the same database again.
  expect(await queueStore(createStore(mine.bb)).getReview("pr-1")).toBeNull();

  const former = createFakePluginHost({ pluginId: "guided-review", dataDir });
  expect(await queueStore(createStore(former.bb)).listReviews()).toEqual([]);
});

test("with no former install, the store starts empty", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace", dataDir: newDataDir() });
  expect(await queueStore(createStore(bb)).listReviews()).toEqual([]);
});

test("the former install's recorded assistant keeps its tools; its unrecorded threads get none", async () => {
  const h = createFakePluginHost({ pluginId: "code-review-workspace", dataDir: await formerDataDir() });
  await plugin(h.bb);
  const resolve = (id: string) => h.harness.behavior.resolveAgentConfiguration({
    pluginMetadata: {}, thread: { id, title: "Review agent: pr-1", parentThreadId: null, sourceThreadId: null },
    project: { id: "p1", kind: "standard", name: "p", gitRemoteUrl: null },
    environment: { id: "env-1", name: null, path: null, workspaceProvisionType: "unmanaged", branchName: null },
    host: { id: "host-1", name: "h" }, provider: { id: "claude-code", model: "opus", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: "guided-review" },
  } as PluginAgentConfigurationContext);
  expect((await resolve("assistant-1")).tools.map((tool) => tool.name)).toContain("add_draft_comment");
  expect(await resolve("stranger")).toMatchObject({ tools: [], skills: [] });
});
