import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { checkCoverage, validateGuide } from "./guide";
import { chapterAt, droppedNear, fitHunks, hunkCounts, hunksIn, keepHunks } from "./hunks";
import { buildGenerationPrompt, generateGuide } from "./generate";
import plugin from "../server";
import { spawnPrompt, toolFailed, toolText } from "./fake-host.test-support";

// a.ts has three hunks: lines 2, 20 and 40 change.
const a = [
  "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts",
  "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three",
  "@@ -19,3 +19,3 @@", " x", "-y", "+Y", " z",
  "@@ -39,2 +39,3 @@", " p", "+q", " r",
].join("\n") + "\n";
const b = "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-b\n+B\n";
const patch = a + b;
const files = ["a.ts", "b.ts"];

const section = (id: string, diffs: Array<{ file: string; hunks?: number[] }>) => ({ id, title: id, overview: "o", diffs: diffs.map((d) => ({ summary: "s", ...d })) });
const guide = (...sections: ReturnType<typeof section>[]) => {
  const v = validateGuide({ title: "T", intent: "I", sections });
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.guide;
};
const coverage = (...sections: ReturnType<typeof section>[]) => checkCoverage(guide(...sections), files, hunkCounts(patch));

test("a guide entry can name the hunks of its file it covers", () => {
  const v = validateGuide({ title: "T", intent: "I", sections: [section("s1", [{ file: "a.ts", hunks: [1, 3] }])] });
  expect(v.ok && v.guide.sections[0]?.diffs[0]?.hunks).toEqual([1, 3]);
  expect(validateGuide({ title: "T", intent: "I", sections: [section("s1", [{ file: "a.ts", hunks: [] }])] }).ok).toBe(false);
  expect(validateGuide({ title: "T", intent: "I", sections: [section("s1", [{ file: "a.ts", hunks: [0] }])] }).ok).toBe(false);
});

test("coverage takes a split file when each of its hunks is in exactly one chapter", () => {
  expect(coverage(section("s1", [{ file: "a.ts", hunks: [1, 3] }, { file: "b.ts" }]), section("s2", [{ file: "a.ts", hunks: [2] }]))).toEqual({ ok: true });
  // Without hunks, as in every guide before them, a file is whole.
  expect(coverage(section("s1", [{ file: "a.ts" }, { file: "b.ts" }]))).toEqual({ ok: true });
  expect(checkCoverage(guide(section("s1", [{ file: "a.ts" }, { file: "b.ts" }])), files)).toEqual({ ok: true });
});

test("coverage errors say which hunks are missing, doubled, or don't exist", () => {
  expect(coverage(section("s1", [{ file: "a.ts", hunks: [1] }, { file: "b.ts" }]), section("s2", [{ file: "a.ts", hunks: [1, 2] }]))).toEqual({ ok: false, errors: [
    "duplicate: hunk 1 of a.ts is in more than one chapter",
    "missing: hunk 3 of a.ts isn't in any chapter",
  ] });
  expect(coverage(section("s1", [{ file: "a.ts" }, { file: "b.ts" }]), section("s2", [{ file: "a.ts", hunks: [2, 3] }]))).toEqual({ ok: false, errors: [
    "duplicate: hunks 2, 3 of a.ts are in more than one chapter",
  ] });
  expect(coverage(section("s1", [{ file: "a.ts", hunks: [1, 2, 3, 5] }, { file: "b.ts", hunks: [2] }]))).toEqual({ ok: false, errors: [
    "hunks: a.ts has 3 hunks, so there's no hunk 5",
    "hunks: b.ts has 1 hunk, so there's no hunk 2",
  ] });
  expect(coverage(section("s1", [{ file: "a.ts", hunks: [1] }, { file: "a.ts", hunks: [2, 3] }, { file: "b.ts" }]))).toEqual({ ok: false, errors: [
    "duplicate: a.ts is listed twice in s1; list it once, with all its hunks there",
  ] });
  // Whole files keep their old errors.
  expect(coverage(section("s1", [{ file: "a.ts" }]), section("s2", [{ file: "a.ts" }]))).toEqual({ ok: false, errors: [
    "duplicate: a.ts appears 2 times",
    "missing: b.ts is in the diff but not in the guide",
  ] });
});

test("generate_review_guide checks a split file's hunks against the diff", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  store.savePatch("pr-1", patch);
  const generationId = store.beginGeneration("pr-1");
  const submit = (sections: ReturnType<typeof section>[]) => harness.behavior.callAgentTool("generate_review_guide", { targetKey: "pr-1", generationId, guide: { title: "T", intent: "I", sections: sections.map((s) => ({ ...s, risk: "low" })) } });
  const bad = await submit([section("s1", [{ file: "a.ts", hunks: [1] }, { file: "b.ts" }])]);
  expect(toolFailed(bad)).toBe(true);
  expect(toolText(bad)).toContain("missing: hunks 2, 3 of a.ts aren't in any chapter");
  const good = await submit([section("s1", [{ file: "a.ts", hunks: [1] }, { file: "b.ts" }]), section("s2", [{ file: "a.ts", hunks: [2, 3] }])]);
  expect(toolFailed(good)).toBeFalsy();
  expect(store.getGuide("pr-1")?.sections.map((s) => s.diffs.map((d) => d.hunks))).toEqual([[[1], undefined], [[2, 3]]]);
});

test("a split file's part keeps its headers and only its hunks", () => {
  expect(keepHunks(a, (_, i) => i === 1)).toBe("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -19,3 +19,3 @@\n x\n-y\n+Y\n z\n");
  expect(keepHunks(a, () => false)).toBe("");
  // Since your review: the changed hunks that are also in this part.
  const part = keepHunks(a, (_, i) => i > 0);
  expect(hunksIn(keepHunks(a, (_, i) => i !== 1), part)).toBe(keepHunks(a, (_, i) => i === 2));
});

test("changes gone since your review go with the hunks nearest where they were", () => {
  const gone = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -18,2 +18,2 @@\n-w\n+W\n w2\n@@ -45 +45 @@\n-s\n+S\n";
  expect(droppedNear(gone, a, [2])).toBe("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -18,2 +18,2 @@\n-w\n+W\n w2\n");
  expect(droppedNear(gone, a, [1, 3])).toBe("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -45 +45 @@\n-s\n+S\n");
});

test("a line opens in the chapter holding its hunk", () => {
  const sections = [section("s1", [{ file: "a.ts", hunks: [1, 3] }, { file: "b.ts" }]), section("s2", [{ file: "a.ts", hunks: [2] }])];
  expect(chapterAt(sections, patch, { file: "a.ts", line: 20, side: "RIGHT" })?.id).toBe("s2");
  expect(chapterAt(sections, patch, { file: "a.ts", line: 20, side: "LEFT" })?.id).toBe("s2");
  expect(chapterAt(sections, patch, { file: "a.ts", line: 40, side: "RIGHT" })?.id).toBe("s1");
  // A line in no hunk, or the file itself, opens its first chapter.
  expect(chapterAt(sections, patch, { file: "a.ts", line: 0, side: "RIGHT" })?.id).toBe("s1");
  expect(chapterAt(sections, patch, { file: "b.ts", line: 1, side: "RIGHT" })?.id).toBe("s1");
});

test("hunks that no longer fit the diff fall back to whole files, in the first chapter that lists them", () => {
  const sections = [section("s1", [{ file: "a.ts", hunks: [1, 3] }, { file: "b.ts" }]), section("s2", [{ file: "a.ts", hunks: [2] }])];
  expect(fitHunks(sections, patch)).toBe(sections);
  // A new revision of a.ts with two hunks: hunk 3 is gone.
  const fewer = keepHunks(a, (_, i) => i < 2) + b;
  expect(fitHunks(sections, fewer).map((s) => s.diffs)).toEqual([[{ file: "a.ts", summary: "s" }, { file: "b.ts", summary: "s" }]]);
});

test("the guide writer's earlier chapters name their hunks, or whole files when the new diff doesn't fit them", async () => {
  const sections = [section("s1", [{ file: "a.ts", hunks: [1, 3] }, { file: "b.ts" }]), section("s2", [{ file: "a.ts", hunks: [2] }])];
  const earlier = { guide: guide(...sections), reviewed: false };
  const prompt = buildGenerationPrompt("pr-1", "g", undefined, earlier);
  expect(prompt).toContain("- s1: s1 (a.ts hunks 1, 3, b.ts)");
  expect(prompt).toContain("- s2: s2 (a.ts hunks 2)");

  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), archive: async () => {}, stop: async () => {},
    get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }), send: async () => ({}),
  } } as any });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, headSha: "sha2", status: "ready", createdAt: 1, projectId: "p1" });
  store.saveGuide("pr-1", earlier.guide);
  // The new commits leave a.ts with two hunks.
  store.savePatch("pr-1", keepHunks(a, (_, i) => i < 2) + b);
  harness.inspection.sdk.stub("threads.wait", async () => ({ matched: true }));
  await generateGuide(bb, store, "pr-1", "p1", { notify: false });
  const rebuilt = spawnPrompt(harness.inspection.sdk.callsTo("threads.spawn")[0][0]);
  expect(rebuilt).toContain("- s1: s1 (a.ts, b.ts)");
  expect(rebuilt).not.toContain("- s2:");
});
