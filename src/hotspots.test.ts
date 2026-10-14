import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { checkHotspots, validateGuide } from "./guide";
import plugin from "../server";
import { toolFailed, toolText } from "./fake-host.test-support";

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +10,3 @@\n keep\n-old\n+new\n keep2\n";
const guide = (hotspots?: unknown) => ({ title: "T", intent: "I", sections: [{ id: "s1", title: "S", overview: "o", diffs: [{ file: "a.ts", summary: "x" }] }], ...(hotspots ? { hotspots } : {}) });

test("a guide takes 1–3 hotspots, each a file, line, and why", () => {
  expect(validateGuide(guide([{ file: "a.ts", line: 11, why: "Drops the null check." }])).ok).toBe(true);
  expect(validateGuide(guide()).ok).toBe(true);
  const four = Array.from({ length: 4 }, () => ({ file: "a.ts", line: 11, why: "w" }));
  expect(validateGuide(guide(four)).ok).toBe(false);
  expect(validateGuide(guide([{ file: "a.ts", line: 11 }])).ok).toBe(false);
});

test("hotspots must be on new-file lines the diff shows", () => {
  const check = (hotspots: { file: string; line: number; why: string }[]) => checkHotspots({ ...validateGuideOk(guide()), hotspots }, patch);
  expect(check([{ file: "a.ts", line: 11, why: "w" }, { file: "a.ts", line: 10, why: "context" }])).toEqual({ ok: true });
  expect(check([{ file: "b.ts", line: 1, why: "w" }, { file: "a.ts", line: 40, why: "w" }])).toEqual({ ok: false, errors: [
    "hotspots.0: b.ts isn't in the diff",
    "hotspots.1: line 40 of a.ts isn't a new-file line the diff shows",
  ] });
});

test("generate_review_guide refuses a hotspot off the diff, and keeps valid ones", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  store.savePatch("pr-1", patch);
  const generationId = store.beginGeneration("pr-1");
  const bad = await harness.behavior.callAgentTool("generate_review_guide", { targetKey: "pr-1", generationId, guide: guide([{ file: "a.ts", line: 99, why: "w" }]) });
  expect(toolFailed(bad)).toBe(true);
  expect(toolText(bad)).toContain("line 99 of a.ts isn't a new-file line the diff shows");
  const good = await harness.behavior.callAgentTool("generate_review_guide", { targetKey: "pr-1", generationId, guide: guide([{ file: "a.ts", line: 11, why: "Drops the null check." }]) });
  expect(toolFailed(good)).toBeFalsy();
  expect(store.getGuide("pr-1")?.hotspots).toEqual([{ file: "a.ts", line: 11, why: "Drops the null check." }]);
});

function validateGuideOk(raw: unknown) {
  const result = validateGuide(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.guide;
}
