import { expect, test } from "vitest";
import { summaryLine, withSummaryLine } from "./move-to-summary";

test("a moved comment's line says where it was, its severity and words, and keeps an old line's side", () => {
  expect(summaryLine({ file: "src/a.ts", line: 42, side: "RIGHT", severity: "should-fix", body: "Guard the null." })).toBe("- On `src/a.ts:42` (an earlier diff): **Should fix:** Guard the null.");
  expect(summaryLine({ file: "src/a.ts", line: 7, side: "LEFT", startLine: 5, body: "Why drop this?\nIt ran on startup." })).toBe("- On `src/a.ts:5–7` (an earlier diff, old line): Why drop this?\n  It ran on startup.");
});

test("the line goes under the summary's list, or after a blank line, or alone", () => {
  expect(withSummaryLine("", "- On `a.ts:1` (an earlier diff): x")).toBe("- On `a.ts:1` (an earlier diff): x");
  expect(withSummaryLine("Looks good.\n", "- y")).toBe("Looks good.\n\n- y");
  expect(withSummaryLine("Asks:\n- x\n  more of x", "- y")).toBe("Asks:\n- x\n  more of x\n- y");
});
