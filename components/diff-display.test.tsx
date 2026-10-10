// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Each file pierre draws, with the options it was given.
const drawn: { name: string; options: any }[] = [];
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options }: any) => {
    drawn.push({ name: fileDiff.name, options });
    return <div data-testid="filediff"><pre>{fileDiff.additionLines.join("\n")}</pre></div>;
  },
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); drawn.length = 0; });

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const patch = [
  file("src/a.ts", "@@ -1 +1 @@\n-a\n+aa\n"),
  file("src/b.ts", "@@ -1 +1 @@\n-b\n+bb\n"),
  file("src/c.ts", "@@ -1 +1 @@\n-c\n+cc\n"),
].join("");
const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[],
  sections: [
    { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] },
    { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/b.ts", summary: "Caches a row." }, { file: "src/c.ts", summary: "Evicts a row." }] },
  ],
};

async function renderWorkspace({ rpc = {} }: { rpc?: Record<string, unknown> } = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: vi.fn(() => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: vi.fn(() => ({ views: [] })),
    setFileViewed: vi.fn(() => ({ ok: true })),
    setFilesViewed: vi.fn(() => ({ ok: true })),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: vi.fn(() => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } })),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: vi.fn(() => ({ ok: true })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  // Focus mode shows the title without the full header's heading.
  await slot.findAllByText("Parse rows");
  return { slot, rpc: handlers };
}

const viewed = (...files: string[]) => ({ views: files.map((file) => ({ file, viewed: true, stale: false })) });

test("a file you viewed opens folded, without drawing its diff first", async () => {
  patchReviewState("pr-42", { activeId: "c2" });
  // Views take a round trip longer than the bundle.
  const { slot } = await renderWorkspace({ rpc: { getFileViews: () => new Promise((resolve) => setTimeout(() => resolve(viewed("src/b.ts")), 30)) } });
  await slot.findByText("cc");
  await waitFor(() => expect((slot.getByRole("checkbox", { name: "Viewed src/b.ts" }) as HTMLInputElement).checked).toBe(true));
  expect(drawn.map((d) => d.name)).not.toContain("src/b.ts");
  slot.lifecycle.unmount();
});

test("an older viewed-state refresh landing last doesn't undo a newer mark", async () => {
  patchReviewState("pr-42", { activeId: "c2" });
  const replies: ((value: unknown) => void)[] = [];
  const getFileViews = vi.fn(() => getFileViews.mock.calls.length === 1 ? { views: [] } : new Promise((resolve) => replies.push(resolve)));
  const { slot } = await renderWorkspace({ rpc: { getFileViews } });
  await slot.findByText("cc");
  fireEvent.click(slot.getByRole("checkbox", { name: "Viewed src/b.ts" }));
  await waitFor(() => expect(replies).toHaveLength(1));
  fireEvent.click(slot.getByRole("checkbox", { name: "Viewed src/c.ts" }));
  await waitFor(() => expect(replies).toHaveLength(2));
  replies[1](viewed("src/b.ts", "src/c.ts"));
  replies[0](viewed("src/b.ts"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((slot.getByRole("checkbox", { name: "Viewed src/c.ts" }) as HTMLInputElement).checked).toBe(true);
  slot.lifecycle.unmount();
});

test("Mark chapter viewed marks every file in one call, then refreshes once", async () => {
  patchReviewState("pr-42", { activeId: "c2" });
  const { slot, rpc } = await renderWorkspace();
  await slot.findByText("cc");
  await waitFor(() => expect(rpc.getFileViews).toHaveBeenCalledTimes(1));
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Mark chapter viewed" }));
  expect(rpc.setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/b.ts", "src/c.ts"] });
  expect(rpc.setFileViewed).not.toHaveBeenCalled();
  await waitFor(() => expect(rpc.getFileViews).toHaveBeenCalledTimes(2));
  slot.lifecycle.unmount();
});

/** Every ResizeObserver reports this width, as if the workspace sat in a pane that wide. */
function fakeWidth(width: number) {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) { this.notify([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return () => { globalThis.ResizeObserver = original; };
}

test("a narrow workspace on a wide screen goes compact and starts in Focus, until you turn it off", async () => {
  const restore = fakeWidth(600);
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  const main = within(slot.getByRole("main"));
  await waitFor(() => expect(main.getByRole("button", { name: "Show chapters" }).textContent).toContain("Chapters"));
  const focus = main.getByRole("button", { name: "Focus mode" });
  expect(focus.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(focus);
  expect(focus.getAttribute("aria-pressed")).toBe("false");
  slot.lifecycle.unmount();
  const again = await renderWorkspace();
  await again.slot.findByText("aa");
  expect(within(again.slot.getByRole("main")).getByRole("button", { name: "Focus mode" }).getAttribute("aria-pressed")).toBe("false");
  again.slot.lifecycle.unmount();
  restore();
});

test("the toolbar switches between split and unified, and saves the layout", async () => {
  const savePreferences = vi.fn(({ preferences }: any) => ({ preferences, revision: 1 }));
  const { slot } = await renderWorkspace({ rpc: { savePreferences } });
  await slot.findByText("aa");
  expect(drawn.at(-1)!.options.diffStyle).toBe("split");
  const split = within(slot.getByRole("main")).getByRole("button", { name: "Split view" });
  expect(split.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(split);
  await waitFor(() => expect(drawn.at(-1)!.options.diffStyle).toBe("unified"));
  expect(split.getAttribute("aria-pressed")).toBe("false");
  expect(savePreferences).toHaveBeenCalledWith({ preferences: { ...defaultPreferences, diffLayout: "unified" }, revision: 0 });
  slot.lifecycle.unmount();
});

test("Wrap lines wraps the diff's code and sticks in this browser, and starts on in a compact workspace", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  expect(drawn.at(-1)!.options.overflow).not.toBe("wrap");
  const wrap = within(slot.getByRole("main")).getByRole("button", { name: "Wrap lines" });
  expect(wrap.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(wrap);
  await waitFor(() => expect(drawn.at(-1)!.options.overflow).toBe("wrap"));
  slot.lifecycle.unmount();
  drawn.length = 0;
  const again = await renderWorkspace();
  await again.slot.findByText("aa");
  expect(drawn.at(-1)!.options.overflow).toBe("wrap");
  again.slot.lifecycle.unmount();
  localStorage.clear();
  const restore = fakeWidth(600);
  const compact = await renderWorkspace();
  await compact.slot.findByText("aa");
  await waitFor(() => expect(drawn.at(-1)!.options.overflow).toBe("wrap"));
  compact.slot.lifecycle.unmount();
  restore();
});
