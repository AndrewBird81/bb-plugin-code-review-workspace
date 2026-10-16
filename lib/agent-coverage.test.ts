import { expect, test } from "vitest";
import { agentCoverage, readOf } from "./agent-coverage";

const files = ["src/a.ts", "package-lock.json", "src/b.test.ts", "dist/gen.js", "src/c.ts"];

test("counts the files worth reading that the agent read, leaving out lockfiles and generated files, unread in reading order", () => {
  const coverage = agentCoverage(files, { head: "h1", files: ["src/a.ts", "package-lock.json"] }, "h1", new Set(["dist/gen.js"]));
  expect(coverage).toEqual({ read: 1, total: 3, unread: ["src/b.test.ts", "src/c.ts"] });
  expect(readOf(coverage)).toBe("1 of 3 files");
  expect(readOf({ read: 0, total: 1, unread: ["x"] })).toBe("0 of 1 file");
});

test("a file the change put at a path that reads as generated counts as one to read", () => {
  expect(agentCoverage(["src/a.ts", "src/vendor/hook.ts"], { head: "h1", files: ["src/a.ts"] }, "h1", new Set(), new Set(["src/vendor/hook.ts"])))
    .toEqual({ read: 1, total: 2, unread: ["src/vendor/hook.ts"] });
  expect(agentCoverage(["src/a.ts", "src/vendor/hook.ts"], { head: "h1", files: ["src/a.ts"] }, "h1", new Set()).total).toBe(1);
});

test("reads at another head, or none, count for nothing; a local review has no head to differ", () => {
  expect(agentCoverage(files, { head: "h0", files: ["src/a.ts"] }, "h1", new Set()).read).toBe(0);
  expect(agentCoverage(files, null, "h1", new Set()).read).toBe(0);
  expect(agentCoverage(files, { head: "diff:abc", files: ["src/a.ts"] }, undefined, new Set()).read).toBe(1);
});
