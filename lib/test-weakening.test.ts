import { expect, test } from "vitest";
import { testWeakening, weakeningChip, weakeningMark } from "./test-weakening";

const diff = (...lines: string[]) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,${lines.length} +1,${lines.length} @@\n${lines.join("\n")}\n`;

test("counts each assertion marker removed, net of those added", () => {
  const removed = diff(
    "-  expect(total).toBe(3);", "-  assert x == 1", "-  assertEquals(1, x)", "-  Assert.AreEqual(1, x);", "-  result.should.equal(1)",
    "-\tt.Errorf(\"got %d\", x)", "-\tt.Fatal(err)", "-  XCTAssertEqual(x, 1)", "-  assert_eq!(x, 1);", "+  // nothing",
  );
  expect(testWeakening("src/sum.test.ts", removed)).toEqual({ assertionsRemoved: 9, skipsAdded: 0 });
  expect(testWeakening("src/sum.test.ts", diff("-  expect(a).toBe(1);", "-  expect(b).toBe(2);", "+  expect(a + b).toBe(3);"))).toEqual({ assertionsRemoved: 1, skipsAdded: 0 });
});

test("counts each skip marker added: .skip, .only, xit, xdescribe, @Disabled, @Ignore, pytest.mark.skip, t.Skip(", () => {
  const added = diff(
    "+it.skip(\"sums\", () => {", "+describe.only(\"sum\", () => {", "+xit(\"sums\", () => {", "+xdescribe(\"sum\", () => {",
    "+  @Disabled", "+  @Ignore", "+@pytest.mark.skip(reason=\"flaky\")", "+\tt.Skip(\"flaky\")",
  );
  expect(testWeakening("tests/test_sum.py", added)).toEqual({ assertionsRemoved: 0, skipsAdded: 8 });
});

test("assertions and skips that only moved net zero, and a file that isn't a test is never weakened", () => {
  const moved = diff("-  expect(total).toBe(3);", "-it.skip(\"a\", () => {", " keep();", "+  expect(total).toBe(3);", "+it.skip(\"a\", () => {");
  expect(testWeakening("src/sum.test.ts", moved)).toBeNull();
  expect(testWeakening("src/sum.ts", diff("-  assert(total === 3);"))).toBeNull();
  // A test file the repo marks generated isn't one to read.
  expect(testWeakening("src/sum.test.ts", diff("-  expect(total).toBe(3);"), true)).toBeNull();
});

test("the chip and the agents' mark say what was counted", () => {
  expect(weakeningChip({ assertionsRemoved: 3, skipsAdded: 1 })).toBe("3 assertions removed · 1 test skipped");
  expect(weakeningChip({ assertionsRemoved: 1, skipsAdded: 0 })).toBe("1 assertion removed");
  expect(weakeningChip({ assertionsRemoved: 0, skipsAdded: 2 })).toBe("2 tests skipped");
  expect(weakeningMark({ assertionsRemoved: 3, skipsAdded: 1 })).toBe("weakened: 3 assertions removed, 1 skip added");
});
