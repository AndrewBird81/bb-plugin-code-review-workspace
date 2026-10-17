import { afterEach, expect, test, vi } from "vitest";
import { readDraftRecovery, updateDraftRecovery } from "./draft-recovery";

afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

const box = { file: "src/a.ts", line: "12", side: "RIGHT" as const, body: "Half a thought", revision: "r1" };
const stored = (value: unknown) => sessionStorage.setItem("guided-review:draft-recovery:pr-1", typeof value === "string" ? value : JSON.stringify(value));

test("unsaved text reads back as it was kept, per review", () => {
  const composer = { ...box, inline: true, asking: false, startLine: 10, startSide: "LEFT" as const, severity: "nit" as const, editing: "A thought" };
  updateDraftRecovery("pr-1", { composer });
  expect(readDraftRecovery("pr-1")).toEqual({ composer });
  expect(readDraftRecovery("pr-2")).toEqual({});
});

test("a kept box of the wrong shape is dropped, not opened", () => {
  for (const composer of [
    { ...box, file: 3 }, { ...box, line: 12 }, { ...box, body: null }, { ...box, side: "UP" }, { ...box, revision: 7 },
    { ...box, inline: "yes" }, { ...box, asking: 1 }, { ...box, summary: "no" }, { ...box, startLine: 1.5 }, { ...box, startLine: "10" },
    { ...box, startSide: "BOTH" }, { ...box, editing: true },
  ]) {
    stored({ composer });
    expect(readDraftRecovery("pr-1"), JSON.stringify(composer)).toEqual({});
  }
});

test("a selection's other end kept from before range comments is dropped when it comes after the line", () => {
  stored({ composer: { ...box, startLine: 14 } });
  expect(readDraftRecovery("pr-1")).toEqual({ composer: box });
  stored({ composer: { ...box, startLine: 14, startSide: "LEFT" } });
  expect(readDraftRecovery("pr-1").composer).toMatchObject({ startLine: 14, startSide: "LEFT" });
  stored({ composer: { ...box, startLine: 10 } });
  expect(readDraftRecovery("pr-1").composer).toMatchObject({ startLine: 10 });
});

test("an older unsaved summary opens in the summary's box, unless the box holds something else", () => {
  stored({ summary: { body: "Looks right", revision: "r2" } });
  expect(readDraftRecovery("pr-1")).toEqual({ composer: { file: "", line: "0", side: "RIGHT", body: "Looks right", revision: "r2", summary: true } });
  stored({ composer: box, summary: { body: "Looks right" } });
  expect(readDraftRecovery("pr-1")).toEqual({ composer: box, summary: { body: "Looks right" } });
  stored({ summary: { body: "   " } });
  expect(readDraftRecovery("pr-1")).toEqual({});
  stored({ summary: { body: "Looks right", revision: 2 } });
  expect(readDraftRecovery("pr-1")).toEqual({});
});

test("storage that won't parse reads as nothing kept", () => {
  stored("{not json");
  expect(readDraftRecovery("pr-1")).toEqual({});
});

test("clearing the box forgets the review's kept text, and full storage doesn't throw", () => {
  updateDraftRecovery("pr-1", { composer: box });
  updateDraftRecovery("pr-1", { composer: undefined });
  expect(sessionStorage.getItem("guided-review:draft-recovery:pr-1")).toBeNull();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  expect(() => updateDraftRecovery("pr-1", { composer: box })).not.toThrow();
});
