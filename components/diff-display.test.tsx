// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { getReviewState, patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Each file pierre draws, with the options it was given.
const drawn: { name: string; options: any }[] = [];
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options }: any) => {
    drawn.push({ name: fileDiff.name, options });
    return <div data-testid="filediff"><pre>{fileDiff.additionLines.join("\n")}</pre></div>;
  },
}));

// The workspace's renders, by its Submit review button, which draws with its band where BB's title bar didn't take it.
let workspaceRenders = 0;
vi.mock("../lib/draft-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/draft-status")>();
  return { ...actual, useDraftStatus: (targetKey: string) => { workspaceRenders++; return actual.useDraftStatus(targetKey); } };
});

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
  // Opened before, on its first chapter: a first open shows the Overview.
  if (!getReviewState("pr-42").activeId) patchReviewState("pr-42", { activeId: "c1" });
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
  await slot.findByRole("main", { name: "Review" });
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

test("files the repo's .gitattributes marks generated start folded and tagged, without drawing first", async () => {
  patchReviewState("pr-42", { activeId: "c2" });
  const { slot } = await renderWorkspace({ rpc: { getGeneratedFiles: () => ({ files: ["src/b.ts"] }) } });
  await slot.findByText("cc");
  expect(drawn.map((d) => d.name)).not.toContain("src/b.ts");
  const header = within(slot.container.querySelector<HTMLElement>('[data-file="src/b.ts"]')!);
  expect(header.getByText("generated · skip")).toBeTruthy();
  expect(header.getByRole("button", { name: "Show diff of src/b.ts" })).toBeTruthy();
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

test("Mark chapter viewed (⇧V) marks every file in one call, then refreshes once", async () => {
  patchReviewState("pr-42", { activeId: "c2" });
  const { slot, rpc } = await renderWorkspace();
  await slot.findByText("cc");
  await waitFor(() => expect(rpc.getFileViews).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(document.body, { key: "V", shiftKey: true });
  expect(rpc.setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/b.ts", "src/c.ts"] });
  expect(rpc.setFileViewed).not.toHaveBeenCalled();
  await waitFor(() => expect(rpc.getFileViews).toHaveBeenCalledTimes(2));
  slot.lifecycle.unmount();
});

/** Every ResizeObserver reports this width, as if the workspace sat in a pane that wide; resize reports a new one. */
function fakeWidth(width: number) {
  const original = globalThis.ResizeObserver;
  const observed: (() => void)[] = [];
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) {
      const report = () => this.notify([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      observed.push(report);
      report();
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const restore = () => { globalThis.ResizeObserver = original; };
  return Object.assign(restore, { resize: (next: number) => { width = next; observed.forEach((report) => report()); } });
}

test("dragging a wide pane's edge doesn't redraw the workspace on every frame", async () => {
  const restore = fakeWidth(1400);
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  await slot.findByRole("button", { name: /^Submit review/ });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = workspaceRenders;
  for (const width of [1390, 1380, 1370, 1360]) act(() => restore.resize(width));
  expect(workspaceRenders).toBe(before);
  slot.lifecycle.unmount();
  restore();
});

test("a narrow workspace on a wide screen lays out by its own width: the chapters open over the code", async () => {
  // Too narrow for the chapters to dock beside the code, but not a phone's width.
  const restore = fakeWidth(700);
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  expect(slot.queryByRole("navigation", { name: "Chapters" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Show chapters" }));
  const chapters = slot.getByRole("dialog", { name: "Chapters" });
  expect(within(chapters).getByRole("navigation", { name: "Chapters" })).toBeTruthy();
  slot.lifecycle.unmount();
  restore();
});

/** Diff options' Layout: its Unified and Split. */
async function layoutChoices(slot: Awaited<ReturnType<typeof renderWorkspace>>["slot"]) {
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Diff options" }));
  const layout = within(await slot.findByRole("radiogroup", { name: "Layout" }));
  return { unified: layout.getByRole("radio", { name: "Unified" }), split: layout.getByRole("radio", { name: "Split" }) };
}

test("Diff options' Layout switches between split and unified, and saves the layout", async () => {
  const savePreferences = vi.fn(({ preferences }: any) => ({ preferences, revision: 1 }));
  const { slot } = await renderWorkspace({ rpc: { savePreferences } });
  await slot.findByText("aa");
  expect(drawn.at(-1)!.options.diffStyle).toBe("split");
  const { unified, split } = await layoutChoices(slot);
  expect(split.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(unified);
  await waitFor(() => expect(drawn.at(-1)!.options.diffStyle).toBe("unified"));
  expect(split.getAttribute("aria-checked")).toBe("false");
  expect(unified.getAttribute("aria-checked")).toBe("true");
  expect(savePreferences).toHaveBeenCalledWith({ preferences: { ...defaultPreferences, diffLayout: "unified" }, revision: 0 });
  // The arrow keys move the choice, as in any radio group.
  fireEvent.keyDown(unified, { key: "ArrowRight" });
  await waitFor(() => expect(drawn.at(-1)!.options.diffStyle).toBe("split"));
  expect(document.activeElement).toBe(split);
  slot.lifecycle.unmount();
});

test("in a pane too narrow for split, the diff shows unified, and Split is off and says why, saving nothing", async () => {
  const restore = fakeWidth(800);
  const savePreferences = vi.fn(({ preferences }: any) => ({ preferences, revision: 1 }));
  const { slot } = await renderWorkspace({ rpc: { savePreferences } });
  await slot.findByText("aa");
  expect(drawn.at(-1)!.options.diffStyle).toBe("unified");
  const { unified, split } = await layoutChoices(slot);
  await waitFor(() => expect(split.getAttribute("aria-disabled")).toBe("true"));
  expect(unified.getAttribute("aria-checked")).toBe("true");
  expect(slot.getByText("Split view needs a wider pane")).toBeTruthy();
  expect(slot.getByRole("radio", { name: "Split", description: "Split view needs a wider pane" })).toBe(split);
  fireEvent.click(split);
  fireEvent.keyDown(unified, { key: "ArrowRight" });
  expect(savePreferences).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
  restore();
});

test("Wrap long lines wraps the diff's code and sticks in this browser, and starts on in a compact workspace", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  expect(drawn.at(-1)!.options.overflow).not.toBe("wrap");
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Diff options" }));
  const wrap = await slot.findByRole("switch", { name: "Wrap long lines" });
  expect(wrap.getAttribute("aria-checked")).toBe("false");
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
  patchReviewState("pr-42", { activeId: "c1" });
  const compact = await renderWorkspace();
  await compact.slot.findByText("aa");
  await waitFor(() => expect(drawn.at(-1)!.options.overflow).toBe("wrap"));
  compact.slot.lifecycle.unmount();
  restore();
});

test("scrolling measures the chapter's files once a frame, not on every scroll event", async () => {
  patchReviewState("pr-42", { activeId: "c2" });
  const { slot } = await renderWorkspace();
  await slot.findByText("cc");
  const files = Array.from(slot.container.querySelectorAll<HTMLElement>("[data-file]"));
  const measure = vi.fn(() => new DOMRect());
  for (const el of files) el.getBoundingClientRect = measure;
  const scroller = slot.getByRole("main").querySelector<HTMLElement>(".overflow-y-auto")!;
  for (let i = 0; i < 5; i++) fireEvent.scroll(scroller);
  expect(measure).not.toHaveBeenCalled();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(measure).toHaveBeenCalledTimes(files.length);
  slot.lifecycle.unmount();
});
