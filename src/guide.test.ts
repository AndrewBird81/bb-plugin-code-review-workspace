import { test, expect } from "vitest";
import { z } from "zod";
import { validateGuide, checkCoverage, checkGuideInput, checkHotspots, checkRequirements, GuideInputSchema, placeUnplacedFiles, type Guide } from "./guide";

const good = {
  title: "T", intent: "I",
  sections: [{ id: "s1", title: "Sec", overview: "O", diffs: [{ file: "a.ts", summary: "x" }] }],
  unplacedFiles: [],
  review: { gitRef: "main...HEAD" },
};

test("validateGuide accepts a well-formed guide", () => {
  const r = validateGuide(good);
  expect(r.ok).toBe(true);
});

test("validateGuide rejects a missing title", () => {
  const r = validateGuide({ ...good, title: undefined });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toMatch(/title/);
});

test("checkCoverage passes when every file is placed exactly once", () => {
  const r = checkCoverage(good as any, ["a.ts"]);
  expect(r.ok).toBe(true);
});

test("checkCoverage flags omitted, extra, and duplicated files", () => {
  const dup = {
    ...good,
    sections: [
      { id: "s1", title: "A", overview: "o", diffs: [{ file: "a.ts", summary: "x" }] },
      { id: "s2", title: "B", overview: "o", diffs: [{ file: "a.ts", summary: "y" }] },
    ],
  };
  const r = checkCoverage(dup as any, ["a.ts", "b.ts"]);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    const msg = r.errors.join(" ");
    expect(msg).toMatch(/duplicate.*a\.ts/i);
    expect(msg).toMatch(/missing.*b\.ts/i);
  }
});

test("validateGuide rejects duplicate chapter ids and chapters without files", () => {
  const twice = validateGuide({ ...good, sections: [good.sections[0], { ...good.sections[0], diffs: [{ file: "b.ts", summary: "y" }] }] });
  expect(twice.ok).toBe(false);
  if (!twice.ok) expect(twice.errors.join(" ")).toContain("duplicate section id s1");
  const empty = validateGuide({ ...good, sections: [{ ...good.sections[0], diffs: [] }] });
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.errors.join(" ")).toMatch(/sections\.0\.diffs/);
});

test("validateGuide defaults a missing unplacedFiles to none", () => {
  const { unplacedFiles: _, ...rest } = good;
  const r = validateGuide(rest);
  expect(r.ok && r.guide.unplacedFiles).toEqual([]);
});

test("placeUnplacedFiles sums up each unplaced file from the patch", () => {
  const patch = [
    "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n",
    "diff --git a/bin/run b/bin/run\nold mode 100644\nnew mode 100755\n",
    "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts\n",
    "diff --git a/.keep b/.keep\nnew file mode 100644\nindex 0000000..e69de29\n",
  ].join("");
  const guide = { ...good, sections: [], unplacedFiles: ["logo.png", "bin/run", "src/new.ts", ".keep"] };
  const placed = placeUnplacedFiles(guide, patch);
  expect(placed.unplacedFiles).toEqual([]);
  expect(placed.sections.at(-1)!.diffs).toEqual([
    { file: "logo.png", summary: "Binary file." },
    { file: "bin/run", summary: "Made executable." },
    { file: "src/new.ts", summary: "Renamed from `src/old.ts`." },
    { file: ".keep", summary: "New empty file." },
  ]);
});

test("validateGuide takes an empty hotspots, requirements, or focus list as none", () => {
  const r = validateGuide({ ...good, sections: [{ ...good.sections[0], risk: "high", focus: [] }], hotspots: [], requirements: [] });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.guide).not.toHaveProperty("hotspots");
  expect(r.guide).not.toHaveProperty("requirements");
  expect(r.guide.sections[0]).not.toHaveProperty("focus");
  expect(GuideInputSchema.safeParse({ title: "T", intent: "I", sections: [], hotspots: [] }).success).toBe(true);
});

test("a hotspot or requirement can point at removed code with side LEFT, on an old-file line the diff shows", () => {
  const deleted = "diff --git a/auth.ts b/auth.ts\ndeleted file mode 100644\n--- a/auth.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-export const check = (u) => u.isAdmin;\n-export default check;\n";
  const guide = (side?: "LEFT" | "RIGHT", line = 1) => ({ title: "T", intent: "I", unplacedFiles: [], sections: [],
    hotspots: [{ file: "auth.ts", line, side, why: "the admin check is deleted" }],
    requirements: [{ text: "Drop the check", status: "covered", evidence: "Deleted.", file: "auth.ts", line, side }] }) as Guide;
  expect(checkHotspots(guide("LEFT"), deleted)).toEqual({ ok: true });
  expect(checkRequirements(guide("LEFT"), deleted)).toEqual({ ok: true });
  // A deleted file has no new-file lines, and the old file has no line 3.
  expect(checkHotspots(guide(), deleted).ok).toBe(false);
  expect(checkHotspots(guide("RIGHT"), deleted).ok).toBe(false);
  expect(checkHotspots(guide("LEFT", 3), deleted)).toEqual({ ok: false, errors: ["hotspots.0: line 3 of auth.ts isn't an old-file line the diff shows"] });
  // A guide stored before side existed reads its lines as new-file ones.
  expect(validateGuide({ ...guide(), sections: [] }).ok).toBe(true);
});

const input = { title: "T", intent: "I", sections: [{ id: "s", title: "S", overview: "o", risk: "low", diffs: [{ file: "a.ts", summary: "x" }] }] };
const errorsOf = (raw: unknown) => { const r = checkGuideInput(raw); return r.ok ? [] : r.errors; };

test("a submitted chapter needs a risk, and a medium- or high-risk one a focus, though stored guides without them still read", () => {
  expect(errorsOf(input)).toEqual([]);
  const { risk: _, ...riskless } = input.sections[0];
  expect(errorsOf({ ...input, sections: [riskless] })).toEqual(["sections.0.risk: every chapter needs a risk: low, medium, or high"]);
  expect(errorsOf({ ...input, sections: [{ ...input.sections[0], risk: "high" }, { ...input.sections[0], id: "t", risk: "medium", focus: [] }] })).toEqual([
    "sections.0.focus: a high-risk chapter needs a focus: 1–3 things to check",
    "sections.1.focus: a medium-risk chapter needs a focus: 1–3 things to check",
  ]);
  expect(errorsOf({ ...input, sections: [{ ...input.sections[0], risk: "high", focus: ["Check that it retries once."] }] })).toEqual([]);
  // What 0.7.0 stored has no such rules.
  expect(validateGuide({ ...input, sections: [riskless] }).ok).toBe(true);
});

test("a submitted guide can't list the same hotspot twice, on the same side", () => {
  const twice = { ...input, hotspots: [{ file: "a.ts", line: 1, why: "a" }, { file: "a.ts", line: 1, side: "RIGHT", why: "b" }] };
  expect(errorsOf(twice)).toEqual(["hotspots.1: a.ts:1 is already a hotspot; list each place once"]);
  expect(errorsOf({ ...input, hotspots: [{ file: "a.ts", line: 1, why: "a" }, { file: "a.ts", line: 1, side: "LEFT", why: "b" }] })).toEqual([]);
  expect(validateGuide(twice).ok).toBe(true);
});

test("a submitted guide's text is capped, every problem reported at once", () => {
  const long = (n: number) => "x".repeat(n + 1);
  const errors = errorsOf({
    title: long(120), intent: "I",
    sections: [{ id: "s", title: long(120), overview: long(1_200), risk: "high", focus: [long(200)], diffs: [{ file: "a.ts", summary: long(400) }] }],
    hotspots: [{ file: "a.ts", line: 1, why: long(300) }],
  });
  expect(errors.map((e) => e.split(":")[0])).toEqual(["title", "sections.0.title", "sections.0.overview", "sections.0.focus.0", "sections.0.diffs.0.summary", "hotspots.0.why"]);
  expect(errors[0]).toMatch(/<=120 characters/);
});

test("the input's parse drops what the plugin stamps", () => {
  const r = checkGuideInput({ ...input, review: { gitRef: "wrong" }, source: "agent", generator: "agent" });
  expect(r.ok && Object.keys(r.guide)).toEqual(["title", "intent", "sections", "unplacedFiles"]);
});

test("a submitted chapter can't take the Overview page's id, and says why", () => {
  expect(errorsOf({ ...input, sections: [{ ...input.sections[0], id: "overview" }] })).toEqual([
    "sections.0.id: \"overview\" is the Overview page's id; give the chapter another id",
  ]);
  expect(checkGuideInput({ ...input, sections: [{ ...input.sections[0], id: "overview-of-cache" }] }).ok).toBe(true);
  // The writer is told before it submits, in the tool's parameters.
  expect(JSON.stringify(z.toJSONSchema(GuideInputSchema, { io: "input" }))).toContain("Not \\\"overview\\\", the Overview page's.");
});
