import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { checkRequirements, validateGuide } from "./guide";
import { buildGenerationPrompt } from "./generate";
import plugin from "../server";
import { toolFailed, toolText } from "./fake-host.test-support";

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +10,3 @@\n keep\n-old\n+new\n keep2\n";
const section = { id: "s1", title: "S", overview: "o", risk: "low", diffs: [{ file: "a.ts", summary: "x" }] };
const guide = (extra: Record<string, unknown> = {}) => ({ title: "T", intent: "I", sections: [section], ...extra });
const covered = { text: "Retry a failed refresh once", status: "covered", evidence: "refresh() retries on 401.", file: "a.ts", line: 11 };

test("a guide takes optional requirements, each with a status and evidence, and chapters an optional focus", () => {
  const ok = validateGuide(guide({
    requirements: [covered, { text: "Log the retry", status: "missing", evidence: "Nothing logs it." }],
    sections: [{ ...section, risk: "high", focus: ["Check that the retry can't loop."] }],
  }));
  expect(ok.ok && ok.guide.requirements?.map((r) => r.status)).toEqual(["covered", "missing"]);
  expect(ok.ok && ok.guide.sections[0]?.focus).toEqual(["Check that the retry can't loop."]);
  expect(validateGuide(guide({ requirements: [{ ...covered, status: "done" }] })).ok).toBe(false);
  expect(validateGuide(guide({ requirements: [{ text: "x", status: "unclear" }] })).ok).toBe(false);
  expect(validateGuide(guide({ sections: [{ ...section, focus: ["a", "b", "c", "d"] }] })).ok).toBe(false);
  // An empty focus is none (src/guide.test.ts).
  expect(validateGuide(guide({ sections: [{ ...section, focus: [] }] })).ok).toBe(true);
});

test("guides saved before requirements and focus still load as they were", () => {
  const old = validateGuide({ ...guide(), unplacedFiles: [], review: { gitRef: "main...HEAD" } });
  expect(old.ok).toBe(true);
  if (old.ok) {
    expect(old.guide.requirements).toBeUndefined();
    expect(old.guide.sections[0]).toEqual(section);
    expect(checkRequirements(old.guide, patch)).toEqual({ ok: true });
  }
});

test("a requirement's line is a new-file line the diff shows, and a covered one names it", () => {
  const check = (requirements: unknown[]) => {
    const v = validateGuide(guide({ requirements }));
    if (!v.ok) throw new Error(v.errors.join("\n"));
    return checkRequirements(v.guide, patch);
  };
  expect(check([covered, { text: "Log it", status: "partial", evidence: "Only on success.", file: "a.ts", line: 10 }, { text: "Docs", status: "unclear", evidence: "The ticket doesn't say where." }])).toEqual({ ok: true });
  expect(check([
    { ...covered, file: "b.ts", line: 1 },
    { ...covered, line: 40 },
    { text: "Retry", status: "covered", evidence: "Somewhere." },
    { text: "Log it", status: "partial", evidence: "Half.", file: "a.ts" },
  ])).toEqual({ ok: false, errors: [
    "requirements.0: b.ts isn't in the diff",
    "requirements.1: line 40 of a.ts isn't a new-file line the diff shows; for a removed line, give side LEFT and its old-file line",
    "requirements.2: a covered requirement needs the file and line that do it",
    "requirements.3: give both file and line, or neither",
  ] });
});

test("generate_review_guide refuses a requirement off the diff, and keeps requirements and focus", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  store.savePatch("pr-1", patch);
  const generationId = store.beginGeneration("pr-1");
  const bad = await harness.behavior.callAgentTool("generate_review_guide", { targetKey: "pr-1", generationId, guide: guide({ requirements: [{ ...covered, line: 99 }] }) });
  expect(toolFailed(bad)).toBe(true);
  expect(toolText(bad)).toContain("requirements.0: line 99 of a.ts isn't a new-file line the diff shows");
  const focus = ["Check that the retry can't loop."];
  const good = await harness.behavior.callAgentTool("generate_review_guide", { targetKey: "pr-1", generationId, guide: guide({ requirements: [covered], sections: [{ ...section, focus }] }) });
  expect(toolFailed(good)).toBeFalsy();
  expect(store.getGuide("pr-1")?.requirements).toEqual([covered]);
  expect(store.getGuide("pr-1")?.sections[0]?.focus).toEqual(focus);
});

test("the guide writer checks what the PR asks for against the diff", () => {
  expect(buildGenerationPrompt("pr-1", "g")).toMatch(/linked tickets.*requirements/);
});
