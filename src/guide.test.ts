import { test, expect } from "vitest";
import { validateGuide, checkCoverage, checkHotspots, checkRequirements, GuideInputSchema, placeUnplacedFiles, type Guide } from "./guide";

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
