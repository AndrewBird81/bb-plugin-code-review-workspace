// What a test file's diff takes out of its tests: assertions removed and tests skipped, counted from its lines.
import { classifyFile } from "../src/classify";
import { patchRows } from "../src/patch";

export interface TestWeakening {
  /** Assertion lines removed, net of those added: assertions that only moved count nothing. */
  assertionsRemoved: number;
  /** Lines added that skip or focus tests, net of those removed. */
  skipsAdded: number;
}

// expect(…), assert…, Assert.…, .should, Go's t.Error and t.Fatal, and XCTAssert….
const ASSERTION = /\bexpect\s*\(|\b[Aa]ssert|\.should\b|\bt\.(?:Errorf?|Fatalf?|Fail(?:Now)?)\s*\(|XCTAssert/;
// .skip and .only, xit, xdescribe and xtest, @Disabled, @Ignore, pytest.mark.skip, and Go's t.Skip.
const SKIP = /\.(?:skip|only)\b|\bx(?:it|describe|test)\s*\(|@Disabled\b|@Ignore\b|pytest\.mark\.skip|\bt\.Skip(?:f|Now)?\s*\(/;

/** What counts, for the chip's title. */
export const WEAKENING_COUNTED = "Counted from this diff: assertion lines (expect(, assert, .should, t.Error, …) removed, net of those added, and added .skip, .only, xit, xdescribe, @Disabled, @Ignore, pytest.mark.skip or t.Skip(.";

/** A test file's weakening in its diff, or null for a file that isn't a test or whose tests the diff doesn't weaken. `generated`: the repo marks it generated. */
export function testWeakening(path: string, diff: string, generated = false): TestWeakening | null {
  if (classifyFile(path, generated).category !== "test") return null;
  let assertions = 0, skips = 0;
  for (const row of patchRows(diff)) {
    if (row.kind !== "+" && row.kind !== "-") continue;
    const sign = row.kind === "-" ? 1 : -1;
    const code = row.text.slice(1);
    if (ASSERTION.test(code)) assertions += sign;
    if (SKIP.test(code)) skips -= sign;
  }
  const weakening = { assertionsRemoved: Math.max(0, assertions), skipsAdded: Math.max(0, skips) };
  return weakening.assertionsRemoved || weakening.skipsAdded ? weakening : null;
}

/** The file's chip: "3 assertions removed · 1 test skipped". */
export function weakeningChip({ assertionsRemoved, skipsAdded }: TestWeakening): string {
  return [
    assertionsRemoved ? `${assertionsRemoved} assertion${assertionsRemoved === 1 ? "" : "s"} removed` : "",
    skipsAdded ? `${skipsAdded} test${skipsAdded === 1 ? "" : "s"} skipped` : "",
  ].filter(Boolean).join(" · ");
}

/** list_review_files' mark: "weakened: 3 assertions removed, 1 skip added". */
export function weakeningMark({ assertionsRemoved, skipsAdded }: TestWeakening): string {
  return `weakened: ${[
    assertionsRemoved ? `${assertionsRemoved} assertion${assertionsRemoved === 1 ? "" : "s"} removed` : "",
    skipsAdded ? `${skipsAdded} skip${skipsAdded === 1 ? "" : "s"} added` : "",
  ].filter(Boolean).join(", ")}`;
}
