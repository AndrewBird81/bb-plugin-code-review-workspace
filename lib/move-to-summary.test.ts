import { expect, test } from "vitest";
import { summaryLine, withSummaryLine } from "./move-to-summary";

test("a moved comment's line says where it was, its severity and words, and keeps an old line's side", () => {
  expect(summaryLine({ file: "src/a.ts", line: 42, side: "RIGHT", severity: "should-fix", body: "Guard the null." })).toBe("- On `src/a.ts:42` (an earlier diff): **Should fix:** Guard the null.");
  expect(summaryLine({ file: "src/a.ts", line: 7, side: "LEFT", startLine: 5, body: "Why drop this?\nIt ran on startup." })).toBe("- On `src/a.ts:5–7` (an earlier diff, old line): Why drop this?\n  It ran on startup.");
});

test("a moved comment on code the PR didn't change says so, as it would post, only while Pre-existing is on", () => {
  const comment = { file: "src/a.ts", line: 42, side: "RIGHT", severity: "blocking", introduced: false, body: "Already racy." } as const;
  expect(summaryLine(comment, true)).toBe("- On `src/a.ts:42` (an earlier diff): **Pre-existing:** **Blocking:** Already racy.");
  expect(summaryLine(comment)).toBe("- On `src/a.ts:42` (an earlier diff): **Blocking:** Already racy.");
});

test("the line goes under the summary's list, or after a blank line, or alone", () => {
  expect(withSummaryLine("", "- On `a.ts:1` (an earlier diff): x")).toBe("- On `a.ts:1` (an earlier diff): x");
  expect(withSummaryLine("Looks good.\n", "- y")).toBe("Looks good.\n\n- y");
  expect(withSummaryLine("Asks:\n- x\n  more of x", "- y")).toBe("Asks:\n- x\n  more of x\n- y");
});

// bug bash DFT-6: a comment that's only a suggestion put its opening fence at the end of the item's first line, where it
// opens nothing, so its closing fence opened a block that never closed.
test("a moved suggestion's fence starts a line of its own in the item, as it does after a severity", () => {
  const suggestion = { file: "src/a.ts", line: 2, side: "RIGHT" as const, body: "```suggestion\nconst total = rows.length;\n```" };
  expect(summaryLine(suggestion)).toBe("- On `src/a.ts:2` (an earlier diff):\n\n  ```suggestion\n  const total = rows.length;\n  ```");
  expect(summaryLine({ ...suggestion, severity: "nit" })).toBe("- On `src/a.ts:2` (an earlier diff): **Nit:**\n\n  ```suggestion\n  const total = rows.length;\n  ```");
  // The summary's fences pair up.
  const summary = withSummaryLine(withSummaryLine("", summaryLine(suggestion)), summaryLine({ ...suggestion, line: 9, body: "Rename it." }));
  expect(summary.split("\n").filter((line) => /^\s*```/.test(line))).toHaveLength(2);
});
