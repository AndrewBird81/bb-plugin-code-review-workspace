// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { defaultKnobs } from "../lib/knobs";
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

// The workspace's renders, by its Finish review button, which draws with its band where BB's title bar didn't take it.
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

test("with Fold lockfiles and generated files off, a lockfile starts open, and a diff over 1,500 lines still starts folded", async () => {
  const big = file("src/big.ts", `@@ -0,0 +1,1600 @@\n${Array.from({ length: 1600 }, (_, i) => `+row ${i}`).join("\n")}\n`);
  const noisy = { ...guide, sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }, { file: "package-lock.json" }, { file: "src/big.ts" }] }] };
  const { slot } = await renderWorkspace({ rpc: {
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, foldGeneratedFiles: false } }, revision: 1 }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: noisy, patch: patch + file("package-lock.json", "@@ -1 +1 @@\n-{}\n+{ }\n") + big, revision: "r1" }),
  } });
  await slot.findByText("{ }");
  expect(drawn.map((d) => d.name)).not.toContain("src/big.ts");
  expect(within(slot.container.querySelector<HTMLElement>('[data-file="src/big.ts"]')!).getByRole("button", { name: "Show diff of src/big.ts" })).toBeTruthy();
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
  await slot.findByRole("button", { name: /^Finish review:/ });
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

test("Diff options' New and deleted files, or a file's Show as diff, draws a new file as a diff or as a file, saved for every review", async () => {
  const created = "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+fresh\n";
  const sections = [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/new.ts", summary: "Starts rows." }] }, guide.sections[1]];
  const getReviewBundle = () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: { ...structuredClone(guide), sections }, patch: patch + created, revision: "r1" });
  const savePreferences = vi.fn(({ preferences, revision }: any) => ({ preferences, revision: revision + 1 }));
  const { slot } = await renderWorkspace({ rpc: { getReviewBundle, savePreferences } });
  await slot.findByText("fresh");
  expect(drawn.at(-1)!.options.diffIndicators).toBe("bars");
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Diff options" }));
  const choices = within(await slot.findByRole("radiogroup", { name: "New and deleted files" }));
  expect(choices.getByRole("radio", { name: "As file" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(choices.getByRole("radio", { name: "As diff" }));
  await waitFor(() => expect(drawn.at(-1)!.options.diffIndicators).toBe("classic"));
  expect(savePreferences).toHaveBeenCalledWith({ preferences: { ...defaultPreferences, newFiles: "diff" }, revision: 0 });
  // The file's own row switches it back, saved after the first.
  const asDiff = within(slot.container.querySelector<HTMLElement>('[data-file="src/new.ts"] [data-file-header]')!).getByRole("button", { name: "Show as diff" });
  expect(asDiff.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(asDiff);
  await waitFor(() => expect(drawn.at(-1)!.options.diffIndicators).toBe("bars"));
  await waitFor(() => expect(savePreferences).toHaveBeenLastCalledWith({ preferences: { ...defaultPreferences, newFiles: "file" }, revision: 1 }));
  slot.lifecycle.unmount();
});

test("Diff options' Markdown files opens Markdown rendered, saved for every review, and m switches the current file", async () => {
  const doc = "diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-Old words.\n+New words.\n";
  const sections = [{ id: "c1", title: "Docs", overview: "Docs.", diffs: [{ file: "docs/a.md", summary: "Words." }] }, guide.sections[1]];
  const getReviewBundle = () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: { ...structuredClone(guide), sections }, patch: patch + doc, revision: "r1" });
  const savePreferences = vi.fn(({ preferences, revision }: any) => ({ preferences, revision: revision + 1 }));
  const getFileContents = vi.fn(() => ({ ok: true, old: "Old words.\n", new: "New words.\n" }));
  const { slot } = await renderWorkspace({ rpc: { getReviewBundle, savePreferences, getFileContents } });
  const file = () => slot.container.querySelector<HTMLElement>('[data-file="docs/a.md"]')!;
  await waitFor(() => expect(file().querySelector("[data-md-rendered]")).toBeNull());
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Diff options" }));
  const choices = within(await slot.findByRole("radiogroup", { name: "Markdown files" }));
  expect(choices.getByRole("radio", { name: "Source" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(choices.getByRole("radio", { name: "Rendered" }));
  await waitFor(() => expect(file().querySelector("[data-md-rendered]")).toBeTruthy());
  expect(savePreferences).toHaveBeenCalledWith({ preferences: { ...defaultPreferences, markdownFiles: "rendered" }, revision: 0 });
  fireEvent.keyDown(document.body, { key: "Escape" });
  fireEvent.keyDown(document.body, { key: "m" });
  await waitFor(() => expect(file().querySelector("[data-md-rendered]")).toBeNull());
  slot.lifecycle.unmount();
});

test("two quick Layout toggles save one after the other, and the second's layout stays", async () => {
  const { toast } = await import("sonner");
  // A slow server that, like the real one, refuses a save on a revision it has moved past.
  let stored = { preferences: defaultPreferences, revision: 0 };
  const answers: Array<() => void> = [];
  const savePreferences = vi.fn(({ preferences, revision }: any) => new Promise((resolve, reject) => answers.push(() => {
    if (revision !== stored.revision) return reject(new Error("Settings changed elsewhere."));
    stored = { preferences, revision: revision + 1 };
    resolve(stored);
  })));
  const { slot } = await renderWorkspace({ rpc: { savePreferences, getPreferences: () => stored } });
  await slot.findByText("aa");
  const { unified, split } = await layoutChoices(slot);
  fireEvent.click(unified);
  fireEvent.click(split);
  await waitFor(() => expect(answers).toHaveLength(1));
  await act(async () => answers.shift()!());
  await waitFor(() => expect(answers).toHaveLength(1));
  await act(async () => answers.shift()!());
  await waitFor(() => expect(stored.revision).toBe(2));
  expect(savePreferences.mock.calls.map(([call]: any) => [call.preferences.diffLayout, call.revision])).toEqual([["unified", 0], ["split", 1]]);
  expect(stored.preferences.diffLayout).toBe("split");
  expect(toast.error).not.toHaveBeenCalled();
  await waitFor(() => expect(drawn.at(-1)!.options.diffStyle).toBe("split"));
  expect(split.getAttribute("aria-checked")).toBe("true");
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

test("scrolling past a file's end marks the next file in the chapters without drawing the workspace again", async () => {
  patchReviewState("pr-42", { activeId: "c2" });
  const { slot } = await renderWorkspace();
  await slot.findByText("cc");
  await slot.findByRole("button", { name: /^Finish review:/ });
  const row = (name: string) => within(slot.getByRole("navigation", { name: "Chapters" })).getByRole("button", { name });
  await waitFor(() => expect(row("src/b.ts").getAttribute("aria-current")).toBe("true"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // b.ts has scrolled away above the code's top, and c.ts spans it.
  const [b, c] = Array.from(slot.container.querySelectorAll<HTMLElement>("[data-file]"));
  b.getBoundingClientRect = () => ({ top: -400, bottom: -100 }) as DOMRect;
  c.getBoundingClientRect = () => ({ top: -100, bottom: 400 }) as DOMRect;
  const before = workspaceRenders;
  fireEvent.scroll(slot.getByRole("main").querySelector<HTMLElement>(".overflow-y-auto")!);
  await waitFor(() => expect(row("src/c.ts").getAttribute("aria-current")).toBe("true"));
  expect(workspaceRenders).toBe(before);
  slot.lifecycle.unmount();
});

test("a viewed-state refresh that changes nothing doesn't draw the workspace again", async () => {
  let views: Array<{ file: string; viewed: boolean; stale: boolean }> = [];
  const { slot, rpc } = await renderWorkspace({ rpc: { getFileViews: vi.fn(() => ({ views })) } });
  await slot.findByText("aa");
  await slot.findByRole("button", { name: /^Finish review:/ });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The server agrees with the mark already shown.
  views = [{ file: "src/a.ts", viewed: true, stale: false }];
  const reads = rpc.getFileViews.mock.calls.length;
  act(() => { fireEvent.click(slot.getByRole("checkbox", { name: "Viewed src/a.ts" })); });
  const before = workspaceRenders;
  await waitFor(() => expect(rpc.getFileViews.mock.calls.length).toBeGreaterThan(reads));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(workspaceRenders).toBe(before);
  slot.lifecycle.unmount();
});

const weakenedPatch = [
  file("src/sum.test.ts", "@@ -1,3 +1,2 @@\n-  expect(a).toBe(1);\n-  expect(b).toBe(2);\n+it.skip(\"sums\", () => {\n keep();\n"),
  file("src/sum.ts", "@@ -1 +1 @@\n-  assert(a);\n+  b();\n"),
].join("");
const weakenedGuide = { ...guide, sections: [{ id: "c1", title: "Sums", overview: "Sums rows.", diffs: [{ file: "src/sum.test.ts", summary: "Tests sums." }, { file: "src/sum.ts", summary: "Sums." }] }] };
const weakenedBundle = () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(weakenedGuide), patch: weakenedPatch, revision: "r1" });

test("a test file whose diff removes assertions or skips tests carries a chip saying what was counted; code doesn't", async () => {
  patchReviewState("pr-42", { activeId: "c1" });
  const { slot } = await renderWorkspace({ rpc: { getReviewBundle: weakenedBundle } });
  const test = within(await slot.findByRole("region", { name: "src/sum.test.ts" }));
  const chip = await test.findByText("2 assertions removed · 1 test skipped");
  expect(chip.getAttribute("title")).toMatch(/^Counted from this diff: assertion lines .* removed, net of those added, and added \.skip, \.only/);
  expect(within(slot.getByRole("region", { name: "src/sum.ts" })).queryByText(/removed|skipped/)).toBeNull();
  slot.lifecycle.unmount();
});

test("with Flag weakened tests off, a weakened test file has no chip", async () => {
  patchReviewState("pr-42", { activeId: "c1" });
  const { slot } = await renderWorkspace({ rpc: {
    getReviewBundle: weakenedBundle,
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, testWeakening: false } }, revision: 0 }),
  } });
  const test = within(await slot.findByRole("region", { name: "src/sum.test.ts" }));
  await test.findByText("Tests sums.");
  expect(test.queryByText(/assertions removed|skipped/)).toBeNull();
  slot.lifecycle.unmount();
});

const lockfilePatch = file("package-lock.json", '@@ -1,2 +1,4 @@\n-    "node_modules/is-odd": {\n+    "node_modules/tiny": {\n+      "resolved": "https://evil.example.com/tiny-1.0.0.tgz",\n+    "node_modules/left-pad": {\n     "node_modules/lodash": {\n');
const lockfileBundle = () => ({
  review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" },
  guide: { ...guide, sections: [{ id: "c1", title: "Deps", overview: "Adds deps.", diffs: [{ file: "package-lock.json", summary: "Locks deps." }] }] }, patch: lockfilePatch, revision: "r1",
});

test("a lockfile, folded, says how many packages it adds and removes, and warns of a host that isn't its registry", async () => {
  patchReviewState("pr-42", { activeId: "c1" });
  const { slot } = await renderWorkspace({ rpc: { getReviewBundle: lockfileBundle } });
  const lockfile = within(await slot.findByRole("region", { name: "package-lock.json" }));
  expect((await lockfile.findByText("+2 −1 packages")).className).toContain("bg-muted");
  expect(lockfile.getByText("Downloads from evil.example.com").className).toContain("text-warning-text");
  expect(lockfile.getByRole("button", { name: "Show diff of package-lock.json" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("with Summarize lockfile changes off, a lockfile shows only its diff", async () => {
  patchReviewState("pr-42", { activeId: "c1" });
  const { slot } = await renderWorkspace({ rpc: {
    getReviewBundle: lockfileBundle,
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, lockfileDigest: false } }, revision: 0 }),
  } });
  const lockfile = within(await slot.findByRole("region", { name: "package-lock.json" }));
  await lockfile.findByText("Locks deps.");
  expect(lockfile.queryByText(/packages|Downloads from/)).toBeNull();
  slot.lifecycle.unmount();
});

test("a local review's file opens in an editor on the BB server at its first changed line, but not a deleted one, a PR review's, or with Open in editor off", async () => {
  const deleted = "diff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
  const bundle = {
    review: { targetKey: "pr-42", kind: "ref", gitRef: "HEAD", cwd: "/repo/", status: "ready", createdAt: 1, title: "HEAD" },
    guide: { ...guide, sections: [{ id: "c1", title: "Parsing", overview: "", diffs: [{ file: "src/a.ts" }, { file: "src/old.ts" }] }] },
    patch: file("src/a.ts", "@@ -3 +3 @@\n-a\n+aa\n") + deleted, revision: "r1",
  };
  const listMachines = vi.fn(() => ({ machines: [{ hostId: "server", name: "Server", connected: true, server: true }, { hostId: "laptop", name: "Laptop", connected: true, server: false }] }));
  const local = await renderWorkspace({ rpc: { getReviewBundle: () => structuredClone(bundle), listMachines } });
  fireEvent.click(await local.slot.findByRole("link", { name: "Open src/a.ts in editor" }));
  expect(local.slot.inspection.navigateCalls).toContainEqual({ method: "experimental_openFilePreview", options: { target: { kind: "host", hostId: "server", path: "/repo/src/a.ts" }, location: { kind: "line", line: 3, column: null } } });
  expect(local.slot.getByRole("region", { name: "src/old.ts" })).toBeTruthy();
  expect(local.slot.queryByRole("link", { name: "Open src/old.ts in editor" })).toBeNull();
  local.slot.lifecycle.unmount();
  cleanup();

  const pr = await renderWorkspace({ rpc: { listMachines } });
  await pr.slot.findByText("aa");
  expect(pr.slot.queryByRole("link", { name: /in editor$/ })).toBeNull();
  pr.slot.lifecycle.unmount();
  cleanup();

  const preferences = { ...defaultPreferences, knobs: { ...defaultKnobs, openInEditor: false } };
  listMachines.mockClear();
  const off = await renderWorkspace({ rpc: { getReviewBundle: () => structuredClone(bundle), listMachines, getPreferences: () => ({ preferences, revision: 1 }) } });
  await off.slot.findByText("aa");
  expect(off.slot.queryByRole("link", { name: /in editor$/ })).toBeNull();
  expect(listMachines).not.toHaveBeenCalled();
  off.slot.lifecycle.unmount();
});

test("a local review's file opens in an editor only where its diff ends at the checkout: main and main...HEAD, not main...feature or a..b", async () => {
  const listMachines = () => ({ machines: [{ hostId: "server", name: "Server", connected: true, server: true }] });
  const offered = async (gitRef: string) => {
    const bundle = { review: { targetKey: "pr-42", kind: "ref", gitRef, cwd: "/repo", status: "ready", createdAt: 1, title: gitRef }, guide: structuredClone(guide), patch, revision: "r1" };
    const { slot } = await renderWorkspace({ rpc: { getReviewBundle: () => structuredClone(bundle), listMachines } });
    await slot.findByText("aa");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const link = slot.queryByRole("link", { name: "Open src/a.ts in editor" });
    slot.lifecycle.unmount();
    cleanup();
    return link !== null;
  };
  expect(await offered("main")).toBe(true);
  expect(await offered("main...HEAD")).toBe(true);
  expect(await offered("main...feature")).toBe(false);
  expect(await offered("a..b")).toBe(false);
});
