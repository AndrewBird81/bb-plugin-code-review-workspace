import { test, expect } from "vitest";
import { commentsKey, sameComments, severityCounts, severityOf, toGithubReviewPayload, type Draft, type Severity } from "./draft";

const draft: Draft = {
  targetKey: "pr-1",
  verdict: "REQUEST_CHANGES",
  body: "Overall looks close.",
  comments: [{ file: "src/a.ts", line: 42, side: "RIGHT", chapterId: "s1", body: "rename this" }],
};

test("maps a draft to the gh reviews API body", () => {
  expect(toGithubReviewPayload(draft, false, false)).toEqual({
    event: "REQUEST_CHANGES",
    body: "Overall looks close.",
    comments: [{ path: "src/a.ts", line: 42, side: "RIGHT", body: "rename this" }],
  });
});

test("a label at the start of a comment sets its severity and leaves the text", () => {
  expect(severityOf("**Blocking:** This drops writes.")).toEqual({ severity: "blocking", body: "This drops writes." });
  expect(severityOf("blocking: lower case, no bold")).toEqual({ severity: "blocking", body: "lower case, no bold" });
  expect(severityOf("**Blocking**: colon outside")).toEqual({ severity: "blocking", body: "colon outside" });
  expect(severityOf("__Should fix:__ underscores")).toEqual({ severity: "should-fix", body: "underscores" });
  expect(severityOf("**Should fix:** a")).toEqual({ severity: "should-fix", body: "a" });
  expect(severityOf("Should-fix: a")).toEqual({ severity: "should-fix", body: "a" });
  expect(severityOf("**Question:** Why?")).toEqual({ severity: "question", body: "Why?" });
  expect(severityOf("nit: spacing")).toEqual({ severity: "nit", body: "spacing" });
  expect(severityOf("  **NIT:**\n\n```suggestion\nx\n```")).toEqual({ severity: "nit", body: "```suggestion\nx\n```" });
  // Not a label: unclosed bold, the word mid-sentence, or nothing after it.
  expect(severityOf("**Blocking: unclosed")).toEqual({ body: "**Blocking: unclosed" });
  expect(severityOf("Not blocking: fine")).toEqual({ body: "Not blocking: fine" });
  expect(severityOf("Nitpick: x")).toEqual({ body: "Nitpick: x" });
  expect(severityOf("**Blocking:**")).toEqual({ body: "**Blocking:**" });
  // Without a label, the severity given; "none" is no severity. A label wins over it.
  expect(severityOf("plain", "question")).toEqual({ severity: "question", body: "plain" });
  expect(severityOf("plain", "none")).toEqual({ body: "plain" });
  expect(severityOf("nit: x", "blocking")).toEqual({ severity: "nit", body: "x" });
});

test("GitHub gets each comment with its severity's label in front", () => {
  const labeled: Draft = { ...draft, comments: [
    { file: "a.ts", line: 1, side: "RIGHT", severity: "blocking", body: "Drops writes." },
    { file: "a.ts", line: 2, side: "RIGHT", severity: "should-fix", body: "Rename." },
    { file: "a.ts", line: 3, side: "RIGHT", severity: "question", body: "Why?" },
    { file: "a.ts", line: 4, side: "RIGHT", severity: "nit", body: "```suggestion\nconst x = 1;\n```" },
    { file: "a.ts", line: 5, side: "RIGHT", body: "No label." },
  ] };
  expect(toGithubReviewPayload(labeled, false, false).comments.map((c) => c.body)).toEqual([
    "**Blocking:** Drops writes.",
    "**Should fix:** Rename.",
    "**Question:** Why?",
    // A block can't follow the label on its line.
    "**Nit:**\n\n```suggestion\nconst x = 1;\n```",
    "No label.",
  ]);
});

test("a comment's severity is part of what the comments' key compares, and a comment without one keys as before", () => {
  const plain = { file: "a.ts", line: 1, side: "RIGHT" as const, body: "x" };
  expect(commentsKey([plain])).toBe(commentsKey([{ ...plain }]));
  expect(commentsKey([{ ...plain, severity: "nit" }])).not.toBe(commentsKey([plain]));
  expect(sameComments([{ ...plain, severity: "nit" }], [plain])).toBe(false);
  expect(sameComments([{ ...plain, severity: "nit" }], [{ ...plain, severity: "nit" }])).toBe(true);
});

test("severity counts read as the draft shows them", () => {
  const at = (severity?: Severity) => ({ file: "a.ts", line: 1, side: "RIGHT" as const, body: "x", ...(severity ? { severity } : {}) });
  expect(severityCounts([at("blocking"), at("blocking"), at("nit"), at(), at("should-fix")])).toBe("2 blocking · 1 should fix · 1 nit");
  expect(severityCounts([at(), at()])).toBe("");
  expect(severityCounts([at("question"), at("question")])).toBe("2 questions");
  expect(severityCounts([at("nit"), at("nit")])).toBe("2 nits");
});
