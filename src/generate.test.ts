import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { createStore } from "./store";
import plugin from "../server";
import { spawnPrompt, toolFailed, toolText } from "./fake-host.test-support";

const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
`;

async function host() {
  const h = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(h.bb);
  const store = createStore(h.bb); // same pluginId → same DB the factory's tools read
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  store.savePatch("pr-1", patch);
  const generationId = store.beginGeneration("pr-1");
  return { ...h, store, generationId };
}

test("read_review_patch returns stored patch text", async () => {
  const { harness, generationId } = await host();
  const out = await harness.behavior.callAgentTool("read_review_patch", { targetKey: "pr-1" });
  expect(toolText(out)).toContain("diff --git a/a.ts");
});

test("read_review_patch reads one file's diff on request", async () => {
  const { harness, store } = await host();
  store.savePatch("pr-1", patch + patch.replaceAll("a.ts", "b.ts").replace("+new", "+other"));
  const text = (out: any) => String(out.content?.[0]?.text ?? out);
  const one = await harness.behavior.callAgentTool("read_review_patch", { targetKey: "pr-1", file: "b.ts" });
  expect(text(one)).toContain("+other");
  expect(text(one)).not.toContain("a.ts");
  const missing = await harness.behavior.callAgentTool("read_review_patch", { targetKey: "pr-1", file: "c.ts" });
  expect(toolFailed(missing)).toBe(true);
});

test("read_review_patch finds a renamed file by its old path too", async () => {
  const { harness, store } = await host();
  store.savePatch("pr-1", "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 90%\nrename from src/old.ts\nrename to src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-a\n+b\n");
  const out = await harness.behavior.callAgentTool("read_review_patch", { targetKey: "pr-1", file: "src/old.ts" });
  expect(toolFailed(out)).toBeFalsy();
  expect(toolText(out)).toContain("rename to src/new.ts");
});

test("generate_review_guide rejects incomplete coverage then accepts a full guide", async () => {
  const { harness, generationId } = await host();
  const bad = await harness.behavior.callAgentTool("generate_review_guide", {
    targetKey: "pr-1",
    generationId,
    guide: { title: "T", intent: "I", sections: [], unplacedFiles: [], review: { gitRef: "x" } },
  });
  expect(toolFailed(bad)).toBe(true);
  const good = await harness.behavior.callAgentTool("generate_review_guide", {
    targetKey: "pr-1",
    generationId,
    guide: { title: "T", intent: "I", sections: [{ id: "s1", title: "S", overview: "o", diffs: [{ file: "a.ts", summary: "x" }] }], unplacedFiles: [], review: { gitRef: "x" } },
  });
  expect(toolFailed(good)).toBeFalsy();
});

test("generate_review_guide stamps the store's authoritative gitRef (and base) over whatever the guide submitted, and accepts a section risk", async () => {
  const { harness, store, generationId } = await host();
  store.saveReview({
    targetKey: "pr-1",
    kind: "pr",
    number: 1,
    status: "generating",
    createdAt: 1,
    gitRef: "main...feature-authoritative",
    base: "main",
  });

  const good = await harness.behavior.callAgentTool("generate_review_guide", {
    targetKey: "pr-1",
    generationId,
    guide: {
      title: "T",
      intent: "I",
      sections: [
        {
          id: "s1",
          title: "S",
          overview: "o",
          risk: "high",
          diffs: [{ file: "a.ts", summary: "x" }],
        },
      ],
      unplacedFiles: [],
      review: { gitRef: "wrong-or-stale-ref", base: "wrong-base" },
    },
  });
  expect(toolFailed(good)).toBeFalsy();

  const stored = store.getGuide("pr-1");
  expect(stored?.review).toEqual({ gitRef: "main...feature-authoritative", base: "main" });
  expect(stored?.sections[0].risk).toBe("high");
});

test("generate_review_guide stamps gitRef even when the submitted guide omitted review entirely", async () => {
  const { harness, store, generationId } = await host();
  store.saveReview({
    targetKey: "pr-1",
    kind: "pr",
    number: 1,
    status: "generating",
    createdAt: 1,
    gitRef: "main...feature-authoritative",
  });

  const good = await harness.behavior.callAgentTool("generate_review_guide", {
    targetKey: "pr-1",
    generationId,
    guide: {
      title: "T",
      intent: "I",
      sections: [{ id: "s1", title: "S", overview: "o", diffs: [{ file: "a.ts", summary: "x" }] }],
      unplacedFiles: [],
    },
  });
  expect(toolFailed(good)).toBeFalsy();

  const stored = store.getGuide("pr-1");
  expect(stored?.review).toEqual({ gitRef: "main...feature-authoritative" });
});

function baseConfigContext(pluginId: string | null, threadTitle: string | null = null): PluginAgentConfigurationContext {
  return {
    thread: { id: "thread-1", title: threadTitle, parentThreadId: null, sourceThreadId: null },
    project: { id: "project-1", kind: "standard", name: "test-project", gitRemoteUrl: null },
    environment: { id: "env-1", name: null, path: null, workspaceProvisionType: "unmanaged", branchName: null },
    host: { id: "host-1", name: "test-host" },
    provider: { id: "test-provider", model: "test-model", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId },
    pluginMetadata: {},
  };
}

test("agents.configure exposes tools/skill only to this plugin's own generation thread", async () => {
  const h = createFakePluginHost({ pluginId: "guided-review", agentSkillIds: ["guided-review-generate"] });
  await plugin(h.bb);

  const mine = await h.harness.behavior.resolveAgentConfiguration(
    baseConfigContext("guided-review", "Generate guide: pr-1"),
  );
  expect(mine.tools.map((t) => t.name)).toEqual(["read_review_patch", "list_review_files", "read_changes_since_review", "read_pr_context", "generate_review_guide"]);
  expect(mine.skills).toEqual(["guided-review-generate"]);

  const foreign = await h.harness.behavior.resolveAgentConfiguration(
    baseConfigContext("someone-else", "Generate guide: pr-1"),
  );
  expect(foreign.tools).toEqual([]);
  expect(foreign.skills).toEqual([]);

  const absent = await h.harness.behavior.resolveAgentConfiguration(
    baseConfigContext(null, "Generate guide: pr-1"),
  );
  expect(absent.tools).toEqual([]);
  expect(absent.skills).toEqual([]);

  // Same plugin origin: the floating review-agent thread gets the read tool so
  // its chat works across the review, and the draft-comment tools, but never the
  // guide-writing tool/skill. The guide writer never drafts comments.
  const agentThread = await h.harness.behavior.resolveAgentConfiguration(
    baseConfigContext("guided-review", "Review agent: pr-1"),
  );
  expect(agentThread.tools.map((t) => t.name)).toEqual(["read_review_patch", "list_review_files", "list_draft_comments", "add_draft_comment", "edit_draft_comment", "delete_draft_comment", "set_review_summary", "reply_in_discussion",
    "list_feedback", "read_changes_since_review", "read_pr_context", "read_file", "assess_feedback", "draft_thread_reply"]);
  expect(agentThread.skills).toEqual([]);

  // An unrelated same-plugin thread still gets nothing.
  const other = await h.harness.behavior.resolveAgentConfiguration(
    baseConfigContext("guided-review", "Something else: pr-1"),
  );
  expect(other.tools).toEqual([]);
  expect(other.skills).toEqual([]);
});

test("a rebuilt guide for a PR you reviewed checks your feedback instead of reviewing from scratch", async () => {
  const { generateGuide, buildGenerationPrompt } = await import("./generate");
  const { defaultPreferences } = await import("./preferences");
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), archive: async () => {}, stop: async () => {},
    get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }), send: async () => ({}),
  } } as any });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, headSha: "sha2", status: "ready", createdAt: 1, projectId: "p1" });
  store.setLifecycle("pr-1", { submittedVerdict: "REQUEST_CHANGES", submittedAt: 1000, submittedHeadSha: "sha1", signals: { lastReviewAt: 1000, lastReviewSha: "sha1" } });
  store.saveGuide("pr-1", { title: "T", intent: "I", sections: [{ id: "cache", title: "Cache", overview: "o", diffs: [{ file: "a.ts", summary: "s" }] }], unplacedFiles: [] });
  store.setAssistantThread("pr-1", "assistant");
  harness.inspection.sdk.stub("threads.wait", async () => { store.saveGuide("pr-1", { title: "T", intent: "I", sections: [], unplacedFiles: [] }); return { matched: true }; });
  await generateGuide(bb, store, "pr-1", "p1", { notify: false });
  // The guide writer kept the earlier chapters in view and was asked for sinceReview.
  const prompt = spawnPrompt(harness.inspection.sdk.callsTo("threads.spawn")[0][0]);
  expect(prompt).toContain("- cache: Cache (a.ts)");
  expect(prompt).toContain("sinceReview");
  // The review's conversation got the feedback check, with its context only the assistant sees.
  const sent = harness.inspection.sdk.callsTo("threads.send")[0][0] as any;
  expect(sent.input[0].text).toBe(defaultPreferences.verificationPrompt);
  expect(sent.input[1]).toMatchObject({ visibility: "agent-only", text: expect.stringContaining("REQUEST_CHANGES on commit sha1") });
  expect(store.getReview("pr-1")?.verifyingSince).toEqual(expect.any(Number));
  // A first review gets neither.
  expect(buildGenerationPrompt("pr-2", "g", defaultPreferences)).not.toContain("sinceReview");
});

test("a failed rebuild keeps the guide you had", async () => {
  const { generateGuide } = await import("./generate");
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: { spawn: async () => ({ id: "worker" }), archive: async () => {}, stop: async () => {} } } as any });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, headSha: "sha1", status: "ready", createdAt: 1, projectId: "p1" });
  store.savePatch("pr-1", patch);
  store.saveGuide("pr-1", { title: "Kept", intent: "I", sections: [], unplacedFiles: [] });
  store.backupGuide("pr-1");
  store.savePatch("pr-1", "diff --git a/b.ts b/b.ts\n");
  harness.inspection.sdk.stub("threads.wait", async () => { throw new Error("worker timed out"); });
  await generateGuide(bb, store, "pr-1", "p1", { notify: false });
  expect(store.getReview("pr-1")?.status).toBe("error");
  expect(store.getGuide("pr-1")?.title).toBe("Kept");
  expect(store.patch("pr-1")).toBe(patch);
});

test("generate_review_guide advertises the guide's schema and accepts a guide without unplacedFiles", async () => {
  const writer = createFakePluginHost({ pluginId: "guided-review", agentSkillIds: ["guided-review-generate"] });
  await plugin(writer.bb);
  const tool = (await writer.harness.behavior.resolveAgentConfiguration(baseConfigContext("guided-review", "Generate guide: pr-1"))).tools.find((t) => t.name === "generate_review_guide");
  const schema = JSON.stringify(tool?.inputSchema);
  for (const field of ["intent", "overview", "risk", "focus", "summary", "unplacedFiles", "requirements"]) expect(schema).toContain(`"${field}"`);
  expect(schema).toContain("1–2 sentences");
  const { harness, store, generationId } = await host();
  const out = await harness.behavior.callAgentTool("generate_review_guide", {
    targetKey: "pr-1", generationId,
    guide: { title: "T", intent: "I", sections: [{ id: "s1", title: "S", overview: "o", risk: "low", diffs: [{ file: "a.ts", summary: "x" }] }] },
  });
  expect(toolFailed(out)).toBeFalsy();
  expect(store.getGuide("pr-1")?.unplacedFiles).toEqual([]);
});

test("files the guide leaves unplaced get a final low-risk chapter, so the reviewer sees them", async () => {
  const { harness, store, generationId } = await host();
  store.savePatch("pr-1", patch + patch.replaceAll("a.ts", "logo.png"));
  const out = await harness.behavior.callAgentTool("generate_review_guide", {
    targetKey: "pr-1", generationId,
    guide: { title: "T", intent: "I", sections: [{ id: "s1", title: "S", overview: "o", diffs: [{ file: "a.ts", summary: "x" }] }], unplacedFiles: ["logo.png"] },
  });
  expect(toolFailed(out)).toBeFalsy();
  const saved = store.getGuide("pr-1");
  expect(saved?.unplacedFiles).toEqual([]);
  expect(saved?.sections.at(-1)).toMatchObject({ id: "other-files", title: "Other files", risk: "low", diffs: [{ file: "logo.png", summary: expect.any(String) }] });
});

test("the guide writer lists the files first, and patch pages end on file boundaries", async () => {
  const { buildGenerationPrompt } = await import("./generate");
  expect(buildGenerationPrompt("pr-1", "g")).toMatch(/Start with read_pr_context, then list_review_files.*\n.*intent from what the PR says it does/);
  const { harness, store } = await host();
  const second = patch.replaceAll("a.ts", "b.ts");
  store.savePatch("pr-1", patch + second);
  const text = (out: any) => String(out.content?.[0]?.text ?? out);
  expect(text(await harness.behavior.callAgentTool("list_review_files", { targetKey: "pr-1" }))).toMatch(/^a\.ts · modified · \+1 −1 · \d+ chars · code$/m);
  const page = text(await harness.behavior.callAgentTool("read_review_patch", { targetKey: "pr-1", limit: patch.length + 20 }));
  expect(page).toBe(`${patch}\n\n[${patch.length}/${patch.length + second.length} bytes — call again with offset=${patch.length}]`);
});
