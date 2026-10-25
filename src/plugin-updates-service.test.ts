import { afterEach, expect, test, vi } from "vitest";

// The service's minute-long wait passes at once, so the test reaches the check after it.
vi.mock("node:timers/promises", () => ({
  setTimeout: (_ms: number, value: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    globalThis.setTimeout(() => resolve(value), 1);
  }),
}));

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

afterEach(() => { vi.useRealTimers(); });

/** "stopped" once `done` settles, or "still running" a second after it's asked to. */
const within = (done: Promise<void>, ms: number) =>
  Promise.race([done.then(() => "stopped"), new Promise((resolve) => { globalThis.setTimeout(() => resolve("still running"), ms); })]);

test("plugin-updates stops at once when BB stops it while an update check still waits on the network, and doesn't update after", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const available = [{ id: "code-review-workspace", outcome: "update-available", installed: { display: "1.5.0", version: "old" }, candidate: { display: "1.5.1", version: "new" } }];
  let answer!: (entries: typeof available) => void;
  const checkUpdates = vi.fn(async () => available)
    .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  const applyUpdate = vi.fn(async () => ({ outcome: "updated", applied: true, from: available[0].installed, to: available[0].candidate }));
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { plugins: { checkUpdates, applyUpdate } } });
  await plugin(bb);
  bb.storage.database().prepare("UPDATE plugin_updates SET automatic=1 WHERE id=1").run();
  // Idle long enough for an automatic update.
  vi.setSystemTime(Date.now() + 10 * 60_000);
  const service = harness.behavior.runService("plugin-updates");
  await vi.waitFor(() => { expect(checkUpdates).toHaveBeenCalled(); });
  service.controller.abort();
  // BB gives a stopping service 5 s before it marks the plugin degraded and leaves the new one unloaded.
  expect(await within(service.done, 1_000)).toBe("stopped");
  // The check BB stopped it during comes back with an update: the stopped instance leaves it alone.
  answer(available);
  await new Promise((resolve) => { globalThis.setTimeout(resolve, 20); });
  expect(applyUpdate).not.toHaveBeenCalled();
  await harness.lifecycle.dispose();
});
