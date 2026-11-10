import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { FocusStrip } from "./shell/FocusStrip";
import type { FocusRun } from "../src/focus-model";

const run: FocusRun = { id: "r1", head: "abcdef123", startedAt: 1, state: "finding", focuses: [
  { focusId: "docs", label: "Docs", state: "running", queuedAt: 1 },
  { focusId: "tests", label: "Tests", state: "queued", queuedAt: 1 },
] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function width(value: number) {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("440px") && value <= 440, addEventListener() {}, removeEventListener() {} })));
}

test.each([1000, 600, 440])("strip at %ipx has one polite announcement and usable Stop", (size) => {
  width(size);
  const slot = renderSlot({ component: () => <FocusStrip targetKey="r" run={run} /> }, {});
  const status = slot.getByRole("status");
  expect(slot.container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  expect(status.getAttribute("aria-atomic")).toBe("true");
  expect(slot.getByRole("button", { name: "Stop" })).toBeTruthy();
  if (size === 440) {
    expect(status.textContent).toBe("Focuses · 0 of 2 done");
    expect(slot.queryByText(/using 1 agent slot/)).toBeNull();
  } else {
    expect(status.textContent).toContain("General ✓");
    expect(status.textContent).toContain("Docs…");
    expect(status.textContent).toContain("Tests waiting");
    expect(status.textContent).toContain("using 1 agent slot");
  }
  expect(status.querySelector("button")).toBeNull();
});

test("updates replace one live status; more than three focuses use counts", () => {
  width(1000);
  const slot = renderSlot({ component: FocusStrip }, { targetKey: "r", run });
  slot.rerender(<FocusStrip targetKey="r" run={{ ...run, focuses: Array.from({ length: 5 }, (_, i) => ({ ...run.focuses[0], focusId: String(i), state: i < 2 ? "done" : "queued" })) }} />);
  expect(slot.getAllByRole("status")).toHaveLength(1);
  expect(slot.getByRole("status").textContent).toContain("2 of 5 done");
});

test("failure and older commit fold into one dismissible line; dismissal is per run", async () => {
  width(1000);
  const retry = vi.fn(async () => ({ ok: true }));
  const ended: FocusRun = { ...run, state: "done", focuses: [{ ...run.focuses[0], state: "failed", error: "<img src=x onerror=alert(1)>" }] };
  const slot = renderSlot({ component: FocusStrip }, { targetKey: "r", run: ended, head: "new" }, { rpc: { rerunFocusRun: retry } });
  expect(slot.getAllByRole("status")).toHaveLength(1);
  expect(slot.getByRole("status").textContent).toContain("abcdef1");
  expect(slot.getByRole("status").textContent).toContain("<img src=x onerror=alert(1)>");
  expect(slot.container.querySelector("img")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Run again" }));
  await vi.waitFor(() => expect(retry).toHaveBeenCalledWith({ targetKey: "r" }));
  fireEvent.click(slot.getByRole("button", { name: "Got it" }));
  expect(slot.getByRole("status").textContent).toBe("");
  slot.rerender(<FocusStrip targetKey="r" run={{ ...ended, id: "r2" }} head="new" />);
  expect(slot.getByRole("status")).toBeTruthy();
});

test("stopped run offers recovery; dispatched merge has no Stop", () => {
  const slot = renderSlot({ component: FocusStrip }, { targetKey: "r", run: { ...run, state: "stopped" } });
  expect(slot.getByRole("button", { name: "Run again" })).toBeTruthy();
  slot.rerender(<FocusStrip targetKey="r" run={{ ...run, state: "merging", mergeDispatchedAt: 2 }} />);
  expect(slot.queryByRole("button", { name: "Stop" })).toBeNull();
});

test("a pushed but unloaded commit points to Update guide, not a rerun of the same old diff", () => {
  const ended: FocusRun = { ...run, state: "done", focuses: [{ ...run.focuses[0], state: "done" }] };
  const slot = renderSlot({ component: FocusStrip }, { targetKey: "r", run: ended, head: run.head, latestHead: "pushed", updateAction: <button>Update guide</button> });
  expect(slot.getByRole("status").textContent).toContain("older commit");
  expect(slot.getByRole("button", { name: "Update guide" })).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Run again" })).toBeNull();
  slot.rerender(<FocusStrip targetKey="r" run={ended} head="pushed" latestHead="pushed" />);
  expect(slot.getByRole("button", { name: "Run again" })).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Update guide" })).toBeNull();
});

test("the same empty polite live region receives each change once, without announcing controls", () => {
  const slot = renderSlot({ component: FocusStrip }, { targetKey: "r" });
  const live = slot.getByRole("status");
  expect(live.textContent).toBe("");
  slot.rerender(<FocusStrip targetKey="r" run={run} />);
  expect(slot.getByRole("status")).toBe(live);
  expect(slot.container.querySelectorAll('[aria-live]')).toHaveLength(1);
  expect(live.textContent).not.toContain("Stop");
  slot.rerender(<FocusStrip targetKey="r" run={{ ...run, state: "done", focuses: [{ ...run.focuses[0], state: "done" }] }} />);
  expect(slot.getByRole("status")).toBe(live);
  expect(live.textContent).toBe("");
});
