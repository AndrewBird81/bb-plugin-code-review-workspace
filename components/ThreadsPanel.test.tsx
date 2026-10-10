// @vitest-environment jsdom
//
// ThreadsPanel imports hooks (useRpc) from "@get-bb/plugin-sdk/app", which binds
// to `globalThis.__bbPluginRuntime.pluginSdkApp` at module-evaluation time. A
// static `import { ThreadsPanel } from "./ThreadsPanel"` at the top of this file
// would pull that module in (via the import graph) before `installTestPluginRuntime()`
// ever runs, leaving `useRpc` permanently unbound. So: install the runtime first,
// then dynamically `import("./ThreadsPanel")` inside each test (mirrors
// loadPluginApp's thunk pattern from the plugin-sdk testing docs).
import { test, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";

installTestPluginRuntime();

// vitest.config.ts does not enable `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) (which relies on detecting a global `afterEach`)
// never registers. Without this, each test's render stays mounted and later
// `getByText` queries see stale DOM from earlier tests in this file.
afterEach(cleanup);

const thread = {
  id: "PRRT_1",
  isResolved: false,
  isOutdated: false,
  path: "src/foo.ts",
  line: 42,
  comments: [{ id: "PRRC_1", databaseId: 111, author: "alice", body: "please fix" }],
};

test("renders a thread's comments and replies to it", async () => {
  const { ThreadsPanel } = await import("./ThreadsPanel");
  const replyToThread = vi.fn(() => ({ ok: true }));
  const slot = renderSlot(
    { component: ThreadsPanel },
    { targetKey: "pr-1" },
    {
      rpc: {
        getReviewThreads: () => ({ threads: [thread] }),
        replyToThread,
      } as any,
    },
  );

  await slot.findByText("please fix");
  expect(slot.getByText("src/foo.ts:42")).toBeTruthy();

  fireEvent.change(slot.getByPlaceholderText("Reply…"), { target: { value: "thanks" } });
  fireEvent.click(slot.getByText("Reply"));

  await vi.waitFor(() => expect(replyToThread).toHaveBeenCalledWith({ targetKey: "pr-1", inReplyTo: 111, body: "thanks" }));
});

test("resolves a thread", async () => {
  const { ThreadsPanel } = await import("./ThreadsPanel");
  const resolveThread = vi.fn(() => ({ ok: true }));
  const slot = renderSlot(
    { component: ThreadsPanel },
    { targetKey: "pr-1" },
    {
      rpc: {
        getReviewThreads: () => ({ threads: [thread] }),
        resolveThread,
      } as any,
    },
  );

  await slot.findByText("Resolve");
  fireEvent.click(slot.getByText("Resolve"));

  await vi.waitFor(() => expect(resolveThread).toHaveBeenCalledWith({ targetKey: "pr-1", threadId: "PRRT_1" }));
});

test("shows an empty state when there are no threads", async () => {
  const { ThreadsPanel } = await import("./ThreadsPanel");
  const slot = renderSlot(
    { component: ThreadsPanel },
    { targetKey: "pr-1" },
    { rpc: { getReviewThreads: () => ({ threads: [] }) } as any },
  );

  await slot.findByText("No review threads yet.");
});

test("shows a distinct error state when loading threads fails", async () => {
  const { ThreadsPanel } = await import("./ThreadsPanel");
  const slot = renderSlot(
    { component: ThreadsPanel },
    { targetKey: "pr-1" },
    {
      rpc: {
        getReviewThreads: () => {
          throw new Error("boom");
        },
      } as any,
    },
  );

  await slot.findByText("Couldn't load review threads.");
  expect(slot.queryByText("No review threads yet.")).toBeNull();
});

test("says when GitHub couldn't be read instead of showing no threads, and when only some were", async () => {
  const { ThreadsPanel } = await import("./ThreadsPanel");
  const failed = renderSlot({ component: ThreadsPanel }, { targetKey: "pr-1" }, { rpc: { getReviewThreads: () => ({ threads: [], error: "HTTP 502: Bad Gateway" }) } as any });
  await failed.findByText("Couldn't load review threads.");
  expect(failed.getByText("HTTP 502: Bad Gateway")).toBeTruthy();
  expect(failed.queryByText("No review threads yet.")).toBeNull();
  failed.lifecycle.unmount();
  const partial = renderSlot({ component: ThreadsPanel }, { targetKey: "pr-1" }, { rpc: { getReviewThreads: () => ({ threads: [thread], error: "gh timed out after 120s" }) } as any });
  await partial.findByText("please fix");
  expect(partial.getByText("Couldn't load every thread: gh timed out after 120s")).toBeTruthy();
});
