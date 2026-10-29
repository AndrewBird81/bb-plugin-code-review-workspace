import { expect, test } from "vitest";
import { cameBackText, finishedText } from "./fixes";

test("what came back says one comment as one, and many as all of them", () => {
  const tally = (sent: number) => ({ sent, reported: sent, inferred: 0, checked: 0, fixed: 0 });
  expect(finishedText(tally(1))).toBe("The main thread reported the comment");
  expect(cameBackText(tally(1))).toBe("The main thread reported the comment you sent");
  expect(cameBackText(tally(3))).toBe("The main thread reported all 3 comments you sent");
});
