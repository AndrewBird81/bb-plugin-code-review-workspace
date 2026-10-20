import { expect, test } from "vitest";
import { plural } from "./plural";

test("a count says its word in the singular only for one", () => {
  expect(plural(1, "file")).toBe("1 file");
  expect(plural(0, "file")).toBe("0 files");
  expect(plural(3, "file")).toBe("3 files");
  expect(plural(2, "reply", "replies")).toBe("2 replies");
});
