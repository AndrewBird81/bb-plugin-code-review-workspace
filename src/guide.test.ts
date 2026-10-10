import { test, expect } from "vitest";
import { validateGuide, checkCoverage } from "./guide";

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
