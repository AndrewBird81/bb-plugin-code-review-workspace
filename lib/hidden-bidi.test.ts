import { expect, test } from "vitest";
import { hasHiddenBidi } from "./hidden-bidi";

const diff = (rows: string) => `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n${rows}`;

test("each bidirectional control GitHub warns of, in an added line, is found", () => {
  for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    expect(hasHiddenBidi("src/a.ts", diff(` keep\n-old\n+x = "${String.fromCodePoint(code)}";\n`))).toBe(true);
  }
});

test("a control in the file's path is found", () => {
  expect(hasHiddenBidi("src/\u202Ests.ts", diff(" keep\n-old\n+new\n"))).toBe(true);
});

test("a control in a removed or context line isn't the change's, and plain text, or a mark like U+200F, isn't one", () => {
  expect(hasHiddenBidi("src/a.ts", diff(" keep\u202E\n-old\u2066\n+new\n"))).toBe(false);
  expect(hasHiddenBidi("src/a.ts", diff(" keep\n-old\n+new \u200F עברית\n"))).toBe(false);
});
