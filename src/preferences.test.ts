import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { AUTOMATIC_REVIEW_BEFORE_EVIDENCE, AUTOMATIC_REVIEW_BEFORE_PRECISION, AUTOMATIC_REVIEW_BEFORE_SUMMARY, VERIFICATION_PROMPT_BEFORE_OPEN_THREADS, defaultPreferences, readPreferences } from "./preferences";
import { buildGenerationPrompt } from "./generate";
import { generateGuide } from "./generate";
import { startConversation } from "./agent";

test("settings persist across stores, reject stale edits, and validate input", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const initial = await harness.behavior.callRpc("getPreferences", null) as any;
  expect(initial.preferences).toEqual(defaultPreferences);
  const preferences = { ...initial.preferences, guideDetail: "detailed", guideInstructions: "Explain migration risks", assistantInstructions: "Focus on security" };
  const saved = await harness.behavior.callRpc("savePreferences", { preferences, revision: initial.revision }) as any;
  expect(saved.revision).toBe(1);
  expect(createStore(bb).getPreferences().preferences).toEqual(preferences);
  await expect(harness.behavior.callRpc("savePreferences", { preferences, revision: 0 })).rejects.toThrow(/changed/);
  await expect(harness.behavior.callRpc("savePreferences", { preferences: { ...preferences, guideDetail: "invalid" }, revision: 1 })).rejects.toThrow();
  expect(buildGenerationPrompt("pr-1", "run-1", preferences)).toContain("Explain migration risks");
  expect(buildGenerationPrompt("pr-1", "run-1", preferences)).toContain("Detailed");
  expect(buildGenerationPrompt("pr-1", "run-1", preferences)).not.toContain("Focus on security");
});

test("a page from before 0.5.1 saves settings without the thread-list setting, which keeps its saved value", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const off = await harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, threadListReviews: false }, revision: 0 }) as any;
  const { threadListReviews: _omitted, ...older } = { ...defaultPreferences, guideDetail: "detailed" as const };
  const saved = await harness.behavior.callRpc("savePreferences", { preferences: older, revision: off.revision }) as any;
  expect(saved.preferences).toMatchObject({ guideDetail: "detailed", threadListReviews: false });
  expect(createStore(bb).getPreferences().preferences.threadListReviews).toBe(false);
});

test("a re-review shows what changed since your review unless Settings says All changes, which a page from before 0.6.0 keeps", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const { rereviewShows: _omitted, ...older } = { ...defaultPreferences, guideDetail: "detailed" as const };
  // Saved before 0.6.0, without it.
  expect(readPreferences(older).rereviewShows).toBe("since");
  const all = await harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, rereviewShows: "all" }, revision: 0 }) as any;
  const saved = await harness.behavior.callRpc("savePreferences", { preferences: older, revision: all.revision }) as any;
  expect(saved.preferences).toMatchObject({ guideDetail: "detailed", rereviewShows: "all" });
  await expect(harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, rereviewShows: "latest" }, revision: saved.revision })).rejects.toThrow();
});

test("an automatic review saved with the default from before the review summary reads as the current default; a custom one stays", async () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.savePreferences({ ...defaultPreferences, automaticReview: AUTOMATIC_REVIEW_BEFORE_SUMMARY, diffLayout: "unified" }, 0);
  expect(store.getPreferences()).toEqual({ preferences: { ...defaultPreferences, diffLayout: "unified" }, revision: 1 });
  expect(defaultPreferences.automaticReview).toContain("set_review_summary");
  expect(defaultPreferences.automaticReview).not.toContain("Put general points in your reply.");
  const custom = `${AUTOMATIC_REVIEW_BEFORE_SUMMARY}\nFocus on security.`;
  store.savePreferences({ ...defaultPreferences, automaticReview: custom }, 1);
  expect(store.getPreferences().preferences.automaticReview).toBe(custom);
});

test("private notes persist independently of drafts, with conflict protection", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", status: "ready", createdAt: 1 });
  store.setVerdict("pr-1", "COMMENT", "Existing public summary");
  expect(await harness.behavior.callRpc("getReviewerNotes", { targetKey: "pr-1" })).toEqual({ body: "", revision: 0 });
  await harness.behavior.callRpc("saveReviewerNotes", { targetKey: "pr-1", body: "Private thought", revision: 0 });
  await expect(harness.behavior.callRpc("saveReviewerNotes", { targetKey: "pr-1", body: "Stale edit", revision: 0 })).rejects.toThrow(/changed/);
  store.clearSubmittedDraft(store.getDraft("pr-1"));
  store.setLifecycle("pr-1", { prState: "MERGED", archivedAt: Date.now() });
  expect(createStore(bb).getReviewerNotes("pr-1")).toEqual({ body: "Private thought", revision: 1 });
  expect(store.getDraft("pr-1").body).toBe("");
});

test("workers receive current customization without private notes", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), wait: async () => {}, stop: async () => {}, archive: async () => {},
  } } });
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1, projectId: "project" });
  store.saveReviewerNotes("target", "PRIVATE-SCRATCHPAD", 0);
  store.savePreferences({ ...defaultPreferences, guideInstructions: "Explain public contracts", assistantInstructions: "Focus on security" }, 0);
  await generateGuide(bb, store, "target", "project");
  expect(harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ prompt: expect.stringContaining("Explain public contracts") });
  await startConversation(bb, store, { targetKey: "target", text: "Explain this", agent: { providerId: "codex", model: "gpt-6", reasoningLevel: "low" } });
  // Assistant preferences reach the conversation as instructions, not in its messages.
  expect(JSON.stringify(harness.inspection.sdk.callsTo("threads.spawn"))).not.toMatch(/PRIVATE-SCRATCHPAD|Focus on security/);
});

const codex = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", permissionMode: "auto", serviceTier: "ultrafast" } as const;
const claude = { providerId: "claude-code", model: "opus", reasoningLevel: "max", permissionMode: "full" } as const;
const explicit = { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" };

test("agent selections default to project defaults, persist, and validate", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  // Settings saved before agent selections existed load as project defaults.
  bb.storage.database().prepare(`INSERT INTO review_preferences (id,value,revision) VALUES (1,?,1)`)
    .run(JSON.stringify({ guideDetail: "detailed", guideInstructions: "", assistantInstructions: "", diffLayout: "split" }));
  const initial = await harness.behavior.callRpc("getPreferences", null) as any;
  expect(initial.preferences).toMatchObject({ guideDetail: "detailed", guideAgent: null, assistantAgent: null, automaticReview: defaultPreferences.automaticReview });
  const preferences = { ...initial.preferences, guideAgent: codex, assistantAgent: claude };
  await harness.behavior.callRpc("savePreferences", { preferences, revision: 1 });
  expect(createStore(bb).getPreferences().preferences).toEqual(preferences);
  for (const assistantAgent of [{ ...claude, permissionMode: "ask" }, { ...claude, model: "" }, { ...claude, reasoningLevel: "extreme" }, { ...claude, extra: true }]) {
    await expect(harness.behavior.callRpc("savePreferences", { preferences: { ...preferences, assistantAgent }, revision: 2 })).rejects.toThrow();
  }
  expect(createStore(bb).getPreferences()).toEqual({ preferences, revision: 2 });
});

/** A provider as bb lists it, running in `modes`. */
const provider = (id: string, modes: string[]) => ({ id, available: true, capabilities: { permissionModes: modes } });

test("each agent starts with its own selection, sourced as the user's choice; on the defaults, the hidden guide writer at bb's lowest permission mode", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), wait: async () => {}, output: async () => "Answer", stop: async () => {}, archive: async () => {},
  }, projects: { defaultExecutionOptions: async () => ({ providerId: "claude-code", model: "opus", reasoningLevel: "high", permissionMode: "full" }) },
  providers: { list: async () => [provider("claude-code", ["accept-edits", "auto", "full"])] } } as any });
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1, projectId: "project" });
  await generateGuide(bb, store, "target", "project");
  // On the project's defaults, only the guide writer's permission mode is set (src/generate.ts).
  const execution = ["providerId", "model", "reasoningLevel", "serviceTier"];
  for (const key of execution) expect(harness.inspection.sdk.callsTo("threads.spawn")[0][0]).not.toHaveProperty(key);
  expect(harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ permissionMode: "accept-edits", executionInputSources: { permissionMode: "explicit" } });

  store.savePreferences({ ...defaultPreferences, guideAgent: codex, assistantAgent: claude }, 0);
  await generateGuide(bb, store, "target", "project");
  await startConversation(bb, store, { targetKey: "target", text: "Explain this", agent: { providerId: claude.providerId, model: claude.model, reasoningLevel: claude.reasoningLevel } });
  const [, guide, assistant] = harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => args as any);
  expect(guide).toMatchObject({ title: "Generate guide: target", ...codex, executionInputSources: { ...explicit, serviceTier: "explicit" } });
  expect(assistant).toMatchObject({ title: "Review agent: target", ...claude, executionInputSources: explicit });
  expect(assistant).not.toHaveProperty("serviceTier");
  expect(assistant.executionInputSources).not.toHaveProperty("serviceTier");
});

test("on the defaults, the guide writer runs at accept-edits, else auto, where the project's provider runs in it, else at the project's mode", async () => {
  let defaults: unknown = { providerId: "other", model: "m", reasoningLevel: "high", permissionMode: "full" };
  let providers: () => Promise<unknown[]> = async () => [provider("claude-code", ["accept-edits", "auto", "full"]), provider("other", ["auto", "full"])];
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), wait: async () => {}, stop: async () => {}, archive: async () => {},
  }, projects: { defaultExecutionOptions: async ({ projectId }: { projectId: string }) => projectId === "project" ? defaults : null },
  providers: { list: () => providers() } } as any });
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1, projectId: "project" });
  const mode = async () => {
    await generateGuide(bb, store, "target", "project");
    const spawn = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as any;
    return spawn.permissionMode ? [spawn.permissionMode, spawn.executionInputSources.permissionMode] : [spawn.executionInputSources?.permissionMode ?? null];
  };
  // A provider without accept-edits gets auto.
  expect(await mode()).toEqual(["auto", "explicit"]);
  // One that runs only at full, one bb doesn't list, a list that fails, and a project with no defaults: the project's mode.
  providers = async () => [provider("other", ["full"])];
  expect(await mode()).toEqual([null]);
  providers = async () => [provider("claude-code", ["accept-edits"])];
  expect(await mode()).toEqual([null]);
  providers = async () => { throw new Error("Connection unavailable"); };
  expect(await mode()).toEqual([null]);
  providers = async () => [provider("other", ["accept-edits", "auto", "full"])];
  expect(await mode()).toEqual(["accept-edits", "explicit"]);
  defaults = null;
  expect(await mode()).toEqual([null]);
});

test("custom selections start from the personal project's remembered defaults, with the guide writer's mode as on the defaults", async () => {
  const defaults = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", permissionMode: "full", serviceTier: "default" };
  let providers = [provider("codex", ["accept-edits", "auto", "full"])];
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { projects: {
    list: async () => [{ id: "proj_work", kind: "standard" }, { id: "proj_personal", kind: "personal" }],
    defaultExecutionOptions: async ({ projectId }: { projectId: string }) => projectId === "proj_personal" ? defaults : null,
  }, providers: { list: async () => providers } } as any });
  await plugin(bb);
  expect(await harness.behavior.callRpc("getAgentDefaults", null)).toEqual({ defaults, guideWriterMode: "accept-edits" });
  providers = [provider("codex", ["auto", "full"])];
  expect(await harness.behavior.callRpc("getAgentDefaults", null)).toEqual({ defaults, guideWriterMode: "auto" });
  // A provider that runs in neither: the project's own mode.
  providers = [provider("codex", ["full"])];
  expect(await harness.behavior.callRpc("getAgentDefaults", null)).toStrictEqual({ defaults });
  harness.inspection.sdk.stub("projects.defaultExecutionOptions", async () => { throw new Error("Connection unavailable"); });
  expect(await harness.behavior.callRpc("getAgentDefaults", null)).toEqual({ defaults: null });
});

test("assistant instructions are capped at 2,000 characters; a longer saved text loads cut to fit", async () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  expect(() => store.savePreferences({ ...defaultPreferences, assistantInstructions: "x".repeat(2001) }, 0)).toThrow();
  bb.storage.database().prepare(`INSERT INTO review_preferences (id,value,revision) VALUES (1,?,1)`)
    .run(JSON.stringify({ ...defaultPreferences, assistantInstructions: "x".repeat(5000) }));
  expect(store.getPreferences().preferences.assistantInstructions).toBe("x".repeat(2000));
});

test("a feedback check saved with the default that replied on every thread reads as the current default; a custom one stays", async () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  expect(VERIFICATION_PROMPT_BEFORE_OPEN_THREADS).toContain("Draft a short reply for each of my threads");
  store.savePreferences({ ...defaultPreferences, verificationPrompt: VERIFICATION_PROMPT_BEFORE_OPEN_THREADS }, 0);
  expect(store.getPreferences().preferences.verificationPrompt).toBe(defaultPreferences.verificationPrompt);
  expect(defaultPreferences.verificationPrompt).toContain("only on open threads where one adds something");
  const custom = `${VERIFICATION_PROMPT_BEFORE_OPEN_THREADS}\nBe kind.`;
  store.savePreferences({ ...defaultPreferences, verificationPrompt: custom }, 1);
  expect(store.getPreferences().preferences.verificationPrompt).toBe(custom);
});

test("an automatic review saved with the default from before precision-first reviews reads as the current default; a custom one stays", async () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  // The default as Settings saved it before.
  expect(AUTOMATIC_REVIEW_BEFORE_PRECISION).toBe("Review this change adversarially. Look up related code or PRs when you need context.\nAdd each finding as an inline draft comment with add_draft_comment. Then write the review summary with set_review_summary: your overall assessment, what blocks merging, and the verdict you'd suggest. Don't repeat the line comments there.\nKeep every comment terse. Skip nitpicks.");
  store.savePreferences({ ...defaultPreferences, automaticReview: AUTOMATIC_REVIEW_BEFORE_PRECISION }, 0);
  expect(store.getPreferences().preferences.automaticReview).toBe(defaultPreferences.automaticReview);
  expect(defaultPreferences.automaticReview).toMatch(/^Review this change for defects a careful senior engineer would block on or want fixed\. Precision over recall.*\n1\. Start with read_pr_context.*\n6\. Then set_review_summary.*otherwise COMMENT\.$/s);
  const custom = `${AUTOMATIC_REVIEW_BEFORE_PRECISION} Focus on security.`;
  store.savePreferences({ ...defaultPreferences, automaticReview: custom }, 1);
  expect(store.getPreferences().preferences.automaticReview).toBe(custom);
});

test("an automatic review saved with the default from before it asked for evidence reads as the current default", async () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  expect(defaultPreferences.automaticReview).toBe(AUTOMATIC_REVIEW_BEFORE_EVIDENCE.replace("add a ```suggestion block.", "add a ```suggestion block. Put how you confirmed it in evidence, with file:line: only what you read or ran."));
  store.savePreferences({ ...defaultPreferences, automaticReview: AUTOMATIC_REVIEW_BEFORE_EVIDENCE }, 0);
  expect(store.getPreferences().preferences.automaticReview).toBe(defaultPreferences.automaticReview);
});
