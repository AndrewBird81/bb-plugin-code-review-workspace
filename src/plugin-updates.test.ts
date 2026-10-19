import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPluginUpdates } from "./plugin-updates";

/** `busy` stands for background review work, such as a guide generating; `advance` moves the clock, by an hour and a bit unless told. */
function setup() {
  let now = 1_000_000;
  const background = { busy: false };
  const check = vi.fn(async () => [{ id: "code-review-workspace", outcome: "update-available", installed: { display: "0.2.0", version: "old" }, candidate: { display: "0.2.1", version: "new" } }]);
  const apply = vi.fn(async () => ({ outcome: "updated", applied: true, from: { display: "0.2.0", version: "old" }, to: { display: "0.2.1", version: "new" } }));
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { plugins: { checkUpdates: check, applyUpdate: apply } } });
  const updates = createPluginUpdates(bb, () => background.busy, () => now);
  return { bb, updates, check, apply, background, advance: (ms = 3_600_001) => { now += ms; } };
}

test("automatic updates default off, persist opt-in, and wait for open views to close", async () => {
  const { bb, updates, check, apply, advance } = setup();
  advance(); await updates.tick(); expect(check).not.toHaveBeenCalled();
  updates.setAutomatic(true);
  expect(createPluginUpdates(bb, () => false).status().automatic).toBe(true);
  updates.presence("review-tab", true); advance(); await updates.tick(); expect(apply).not.toHaveBeenCalled();
  updates.presence("review-tab", false); advance(); await updates.tick(); expect(apply).toHaveBeenCalledTimes(1);
});

test("manual update blocks concurrent work and other review windows without expiring their protection", async () => {
  const { updates, apply, advance } = setup();
  updates.presence("settings", true); updates.presence("review", true); advance();
  await expect(updates.apply("settings", "new")).rejects.toThrow(/close/i);
  updates.presence("review", false);
  let finish!: () => void;
  const work = updates.run(() => new Promise<void>(resolve => { finish = resolve; }));
  await expect(updates.apply("settings", "new")).rejects.toThrow(/finish/i);
  finish(); await work;
  await updates.apply("settings", "new"); expect(apply).toHaveBeenCalledTimes(1);
});

test("an update reserves the runtime before checking and rejects new mutations", async () => {
  const { updates, check } = setup(); let finish!: (result: any) => void;
  check.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const applying = updates.apply("settings", "new");
  await expect(updates.run(async () => 1)).rejects.toThrow(/updat/i);
  expect(() => updates.presence("new-review", true)).toThrow(/updat/i);
  finish([{ id: "code-review-workspace", outcome: "current", installed: { display: "0.2.0", version: "old" } }]);
  await expect(applying).rejects.toThrow(/changed|available/i);
});

test("errors stay visible and retries are delayed; a disabled opt-in cancels pending automatic work", async () => {
  const { updates, check, apply, advance } = setup(); updates.setAutomatic(true); advance();
  check.mockRejectedValueOnce(new Error("offline")); await updates.tick();
  expect(updates.status().error).toMatch(/check/i); await updates.tick(); expect(check).toHaveBeenCalledTimes(1);
  advance(); let finish!: (result: any) => void;
  check.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const tick = updates.tick(); updates.setAutomatic(false);
  finish([{ id: "code-review-workspace", outcome: "update-available", installed: { display: "0.2.0", version: "old" }, candidate: { display: "0.2.1", version: "new" } }]);
  await tick; expect(apply).not.toHaveBeenCalled();
});

test("background review work, such as a guide generating, holds automatic and manual updates", async () => {
  const { updates, check, apply, background, advance } = setup();
  updates.setAutomatic(true); background.busy = true; advance();
  await updates.tick();
  expect(check).not.toHaveBeenCalled();
  await expect(updates.apply("settings", "new")).rejects.toThrow("Wait for review work to finish before updating.");
  background.busy = false;
  await updates.tick();
  expect(apply).toHaveBeenCalledTimes(1);
});

test("an automatic update waits five quiet minutes after the last review work", async () => {
  const { updates, check, apply, advance } = setup();
  updates.setAutomatic(true); advance();
  await updates.run(() => {});
  advance(4 * 60_000); await updates.tick();
  expect(check).not.toHaveBeenCalled();
  advance(60_001); await updates.tick();
  expect(apply).toHaveBeenCalledTimes(1);
});

test("review work done while the update is checked cancels the automatic update", async () => {
  const { updates, check, apply, advance } = setup();
  updates.setAutomatic(true); advance();
  let finish!: (result: any) => void;
  check.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const tick = updates.tick();
  // A comment saved during the network wait, finished before GitHub answers.
  await updates.run(() => {});
  finish([{ id: "code-review-workspace", outcome: "update-available", installed: { display: "0.2.0", version: "old" }, candidate: { display: "0.2.1", version: "new" } }]);
  await tick;
  expect(apply).not.toHaveBeenCalled();
});

test("during an update, work is refused with words that fit a terminal or an agent as well as the panel", async () => {
  const { updates, check } = setup(); let finish!: (result: any) => void;
  check.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const applying = updates.apply("settings", "new");
  await expect(updates.run(async () => 1)).rejects.toThrow(/^Code Review Workspace is updating\. Try again in a moment\.$/);
  finish([{ id: "code-review-workspace", outcome: "current", installed: { display: "0.2.0", version: "old" } }]);
  await applying.catch(() => {});
});
