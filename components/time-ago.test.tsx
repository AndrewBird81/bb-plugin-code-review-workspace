import { expect, test } from "vitest";
import { age, timeAgo } from "./time-ago";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DAY = 86_400_000;

test("360 to 364 days read as a year, not 0y", () => {
  expect(age(NOW - 362 * DAY, NOW)).toBe("1y");
  expect(age(NOW - 400 * DAY, NOW)).toBe("1y");
  expect(age(NOW - 800 * DAY, NOW)).toBe("2y");
});

test("under 45 seconds ago reads just now, not now ago", () => {
  expect(timeAgo(NOW - 10_000, NOW)).toBe("just now");
  expect(timeAgo(NOW - 2 * DAY, NOW)).toBe("2d ago");
});
