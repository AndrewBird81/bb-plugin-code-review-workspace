import { expect, test } from "vitest";
import { compileGlob, globMatches } from "./glob";
import { declaredGenerated } from "./classify";
import { scopedInstructions } from "./pr-context";

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

// After "**/" had read a character, what followed it could start mid-name, so "**/b" matched every path ending in "b";
// and "**" inside a name crossed slashes, where git reads it as "*" (bug bash FUZ-1).
test('"**/" matches whole directories, so what follows it starts a name', () => {
  expect(matches("**/types.ts", "src/types.ts")).toBe(true);
  expect(matches("**/types.ts", "src/user-types.ts")).toBe(false);
  expect(matches("src/**/index.ts", "src/index.ts")).toBe(true);
  expect(matches("src/**/index.ts", "src/a/b/index.ts")).toBe(true);
  expect(matches("src/**/index.ts", "src/myindex.ts")).toBe(false);
  expect(matches("src/**/index.ts", "src/a/myindex.ts")).toBe(false);
  expect(matches("**/generated/**", "src/ungenerated/a.ts")).toBe(false);
  expect(matches("a**b", "axb")).toBe(true);
  expect(matches("a**b", "a/b")).toBe(false);
  expect(matches("***/a", "x/a")).toBe(true);
});

test(".gitattributes marks generated only what `git check-attr` does", () => {
  // `git check-attr --stdin linguist-generated` sets only src/types.ts, src/generated/a.ts and generated/a.ts.
  const attributes = "types.ts linguist-generated\n**/generated/** linguist-generated\n";
  expect(declaredGenerated(attributes, ["src/types.ts", "src/user-types.ts", "src/generated/a.ts", "src/ungenerated/a.ts", "generated/a.ts"]))
    .toEqual(["src/types.ts", "src/generated/a.ts", "generated/a.ts"]);
});

test("an .instructions.md file for src/**/index.ts doesn't apply to src/myindex.ts", () => {
  const text = "---\napplyTo: \"src/**/index.ts\"\n---\nKeep index files to re-exports.\n";
  expect(scopedInstructions(text, ["src/myindex.ts"])).toBeNull();
  expect(scopedInstructions(text, ["src/index.ts"])).toBe("Keep index files to re-exports.");
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
