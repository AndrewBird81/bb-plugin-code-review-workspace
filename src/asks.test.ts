import { afterEach, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, type Ask } from "./store";
import { ASK_LIFETIME, askAt, asked, clearAsks, listAsks, setAsk } from "./asks";
import { SUMMARY_AT } from "./draft";

afterEach(() => { vi.useRealTimers(); });

function review() {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  return store;
}
const a = { file: "src/a.ts", line: 3, side: "RIGHT" as const };
const b = { file: "src/a.ts", line: 3, side: "LEFT" as const };
const running = (threadId: string, at = Date.now()): Ask => ({ threadId, state: "running", at });

test("an ask is kept at its location, the summary's apart from the comments', and withdrawn there alone", () => {
  const store = review();
  setAsk(store, "pr-1", SUMMARY_AT, running("t1"));
  setAsk(store, "pr-1", a, running("t2"));
  setAsk(store, "pr-1", b, running("t3"));
  setAsk(store, "pr-1", a, running("t4"));
  const meta = store.getReview("pr-1");
  expect([askAt(meta, SUMMARY_AT), askAt(meta, a), askAt(meta, b)].map((ask) => ask?.threadId)).toEqual(["t1", "t4", "t3"]);
  expect(askAt(null, a)).toBeNull();
  setAsk(store, "pr-1", a, null);
  expect(askAt(store.getReview("pr-1"), a)).toBeNull();
  expect(askAt(store.getReview("pr-1"), b)?.threadId).toBe("t3");
  setAsk(store, "pr-1", SUMMARY_AT, null);
  expect(askAt(store.getReview("pr-1"), SUMMARY_AT)).toBeNull();
});

test("listAsks gives the summary's first, then each comment's with its location", () => {
  const store = review();
  setAsk(store, "pr-1", a, running("t2", 5));
  setAsk(store, "pr-1", SUMMARY_AT, running("t1", 4));
  expect(listAsks(store.getReview("pr-1")!)).toEqual([{ at: SUMMARY_AT, ask: running("t1", 4) }, { at: a, ask: running("t2", 5) }]);
  clearAsks(store, "pr-1");
  expect(listAsks(store.getReview("pr-1")!)).toEqual([]);
});

test("a turn carries an ask only while it runs on that thread, and for ASK_LIFETIME at most", () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const store = review();
  setAsk(store, "pr-1", a, running("t1"));
  expect(asked(store, "pr-1", a, "t1")).toBe(true);
  expect(asked(store, "pr-1", a, "t2")).toBe(false);
  expect(asked(store, "pr-1", a)).toBe(false);
  expect(asked(store, "pr-1", b, "t1")).toBe(false);
  setAsk(store, "pr-1", a, { ...running("t1"), state: "queued" });
  expect(asked(store, "pr-1", a, "t1")).toBe(false);
  setAsk(store, "pr-1", a, running("t1"));
  vi.advanceTimersByTime(ASK_LIFETIME - 1);
  expect(asked(store, "pr-1", a, "t1")).toBe(true);
  vi.advanceTimersByTime(1);
  expect(asked(store, "pr-1", a, "t1")).toBe(false);
});
