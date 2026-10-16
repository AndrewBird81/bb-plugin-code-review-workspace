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

test("a match allocates its two position sets once, not per character of the path", () => {
  const glob = compileGlob("**/gen/*.ts")!;
  const path = "a/".repeat(200) + "gen/x.ts";
  const real = globalThis.Uint8Array;
  let made = 0;
  globalThis.Uint8Array = new Proxy(real, { construct(target, args) { made++; return Reflect.construct(target, args); } });
  try {
    expect(globMatches(glob, path)).toBe(true);
  } finally {
    globalThis.Uint8Array = real;
  }
  expect(made).toBe(2);
});
