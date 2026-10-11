import { expect, test } from "vitest";
import { compileGlob, globMatches } from "./glob";

const matches = (glob: string, path: string) => globMatches(compileGlob(glob)!, path);

test("globs match by gitignore's rules", () => {
  expect(matches("src/*.ts", "src/a.ts")).toBe(true);
  expect(matches("src/*.ts", "src/deep/a.ts")).toBe(false);
  expect(matches("src/**", "src/deep/a.ts")).toBe(true);
  expect(matches("**/a.ts", "a.ts")).toBe(true);
  expect(matches("a/**/b", "a/x/y/b")).toBe(true);
  expect(matches("a/**/b", "a/b")).toBe(true);
  expect(matches("a?c", "abc")).toBe(true);
  expect(matches("a?c", "a/c")).toBe(false);
  expect(matches("[a-c]x", "bx")).toBe(true);
  expect(matches("[!a-c]x", "dx")).toBe(true);
  expect(matches("[!a-c]x", "bx")).toBe(false);
  expect(matches("a[!b]c", "a/c")).toBe(false);
  expect(matches("\\*.ts", "*.ts")).toBe(true);
  expect(matches("\\*.ts", "a.ts")).toBe(false);
});

test("a glob too long or with a backwards range isn't used", () => {
  expect(compileGlob("[z-a]")).toBeNull();
  expect(compileGlob("a".repeat(257))).toBeNull();
});
