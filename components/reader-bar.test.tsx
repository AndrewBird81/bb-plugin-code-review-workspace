// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { interdiff } from "../src/interdiff";
import { getCommentsFolded, patchReviewState } from "../lib/panel-state";
import { bandFit, selectWidth } from "./reading/ReaderBar";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre data-testid="filediff">{fileDiff.additionLines.join("\n")}</pre> }));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); restores.splice(0).forEach((restore) => restore()); });

// The compare select on a re-review: "Since your review" at its fullest, "Since review" brief.
const select = { full: selectWidth("Since your review"), brief: selectWidth("Since review") };

test("a wide band shows everything: All reviews, the review's title, the compare select's full label, and Fold", () => {
  expect(bandFit(1100, 3, 32, select)).toEqual({ back: true, title: true, compare: "full", fold: true });
});

test("as the band narrows, the review's title goes first, then All reviews beside ‹, under 720px of room as the spec says", () => {
  expect(bandFit(760, 3, 32, select)).toEqual({ back: true, title: false, compare: "full", fold: true });
  // With room for it, the review's title shows only in the whole breadcrumb.
  expect(bandFit(719, 3, 32, select)).toEqual({ back: false, title: false, compare: "full", fold: true });
});

test("narrower, the compare select shortens its label, then moves into Diff options, keeping the chapter's title its start", () => {
  // The chapters toggle, Find, ‹, Fold and Diff options at 44px, as on an iPad.
  expect(bandFit(600, 5, 44, select).compare).toBe("full");
  expect(bandFit(480, 5, 44, select).compare).toBe("brief");
  expect(bandFit(400, 5, 44, select).compare).toBeNull();
  // Without a comparison there's none to place.
  expect(bandFit(1100, 3, 32, null).compare).toBeNull();
});

test("short of room, Fold comments moves into Diff options before the chapter's title or the compare select gives way", () => {
  // A short band with a mouse, its commands beside it, as in full screen.
  expect(bandFit(310, 5, 36, select)).toEqual({ back: false, title: false, compare: null, fold: false });
  expect(bandFit(512, 5, 36, select).fold).toBe(true);
  // With the chapters docked, three buttons.
  expect(bandFit(330, 3, 44, select)).toEqual({ back: false, title: false, compare: "brief", fold: false });
  // Without a comparison, Fold stays while the chapter's title has room.
  expect(bandFit(330, 3, 44, null).fold).toBe(true);
});

test("on touch, a band with under 600px of room ends with Diff options alone, off an unfolded iPhone Duo's fold", () => {
  const alone = { back: false, title: false, compare: null, fold: false };
  // Beside Comments docked at 391 on the Duo held sideways: 547px of room.
  expect(bandFit(547, 5, 44, select, true)).toEqual(alone);
  // In full screen there, the chapters docked, before the review's commands: 391px; a first review's too.
  expect(bandFit(391, 3, 44, select, true)).toEqual(alone);
  expect(bandFit(391, 3, 44, null, true)).toEqual(alone);
  // From 600px, as with a mouse, which keeps them under 600 too.
  expect(bandFit(600, 5, 44, select, true)).toMatchObject({ compare: "full", fold: true });
  expect(bandFit(547, 5, 32, select)).toMatchObject({ compare: "full", fold: true });
});

/** Every ResizeObserver reports this size: the workspace's pane, and the band's room in it unless `room` says. */
function fakePane(width: number, height = 900, room = width) {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) {
      const band = !!target.querySelector(":scope > nav[aria-label='Breadcrumb']");
      this.notify([{ target, contentRect: { width: band ? room : width, height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  restores.push(() => { globalThis.ResizeObserver = original; });
}

const file = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+${line}\n`;
const patch = file("src/a.ts", "aa") + file("src/b.ts", "bb");
const reviewed = file("src/a.ts", "a0") + file("src/b.ts", "bb");
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }] }] };

async function renderWorkspace(review: Record<string, unknown> = {}) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", ...review }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }),
  } as any });
  await slot.findAllByTestId("filediff");
  return slot;
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>;
const band = (slot: Slot) => within(slot.getByRole("navigation", { name: "Breadcrumb" }).closest<HTMLElement>("[class*='@container/band']")!);
const rereview = { signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" };

test("the band says where you are, chapter included, as text: the chapters toggle is the one control that shows the chapters", async () => {
  // Too narrow for the chapters to dock: the toggle and Find take their place in the band.
  fakePane(700);
  const slot = await renderWorkspace();
  const crumbs = within(slot.getByRole("navigation", { name: "Breadcrumb" }));
  expect(crumbs.getByText("Chapter 1 of 1: Parsing, 0 of 2 files viewed")).toBeTruthy();
  expect(slot.getAllByRole("button", { name: "Show chapters" })).toHaveLength(1);
  expect(crumbs.queryByRole("button", { name: /Parsing/ })).toBeNull();
  // Under 720px of room, ‹ is All reviews alone.
  expect(crumbs.getByRole("button", { name: "All reviews" }).textContent).toBe("");
  slot.lifecycle.unmount();
});

test("where the band has room for the review's title, it goes to the Overview, a 44px target on touch like the band's buttons", async () => {
  fakePane(1600);
  const slot = await renderWorkspace();
  const title = within(slot.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Parse rows" });
  expect(title.className).toContain("pointer-coarse:h-11");
  fireEvent.click(title);
  await band(slot).findByText("Overview");
  slot.lifecycle.unmount();
});

test("on a re-review the band ends with the compare select, Fold comments and Diff options; on a first review, without the select", async () => {
  fakePane(1400);
  let slot = await renderWorkspace(rereview);
  expect(await band(slot).findByRole("button", { name: "Show changes: All changes" })).toBeTruthy();
  // Before the review's commands, which join the band where BB's title bar didn't take them.
  const controls = () => band(slot).getAllByRole("button").filter((button) => !button.closest("[data-review-commands]")).map((button) => button.getAttribute("aria-label") ?? button.textContent).slice(-3);
  expect(controls()).toEqual(["Show changes: All changes", "Fold comments in code", "Diff options"]);
  slot.lifecycle.unmount();
  slot = await renderWorkspace();
  expect(controls()).toEqual(["Parse rows", "Fold comments in code", "Diff options"]);
  slot.lifecycle.unmount();
});

test("where the band has no room for the compare select, Diff options shows the changes either way, and a commit to pick", async () => {
  // A phone held sideways, its band 360px.
  fakePane(360, 380);
  const slot = await renderWorkspace(rereview);
  expect(band(slot).queryByRole("button", { name: /^Show changes/ })).toBeNull();
  fireEvent.click(band(slot).getByRole("button", { name: "Diff options" }));
  const changes = within(await slot.findByRole("radiogroup", { name: "Show changes" }));
  expect(changes.getByRole("radio", { name: "All" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(changes.getByRole("radio", { name: "Since your review" }));
  expect(changes.getByRole("radio", { name: "Since your review" }).getAttribute("aria-checked")).toBe("true");
  expect(slot.getByRole("button", { name: "Since a commit…" })).toBeTruthy();
  // Fold comments is here too, where the band can leave it for the chapter's title.
  expect(slot.getByRole("switch", { name: "Fold comments in code" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("on touch, the band beside Comments docked on an unfolded iPhone Duo held sideways leaves the compare select and Fold comments to Diff options", async () => {
  fakePane(951, 541, 547);
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as MediaQueryList);
  restores.push(() => matchMedia.mockRestore());
  const slot = await renderWorkspace(rereview);
  const controls = band(slot).getAllByRole("button").filter((button) => !button.closest("[data-review-commands]")).map((button) => button.getAttribute("aria-label"));
  expect(controls.at(-1)).toBe("Diff options");
  expect(controls.filter((label) => /^Show changes|comments in code$/.test(label ?? ""))).toEqual([]);
  fireEvent.click(band(slot).getByRole("button", { name: "Diff options" }));
  expect(await slot.findByRole("switch", { name: "Fold comments in code" })).toBeTruthy();
  expect(slot.getByRole("radiogroup", { name: "Show changes" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a band short of room, as in full screen beside the review's commands, leaves Fold comments and the compare select to Diff options", async () => {
  fakePane(1000, 900, 220);
  const slot = await renderWorkspace(rereview);
  expect(band(slot).queryByRole("button", { name: /^Show changes/ })).toBeNull();
  expect(band(slot).queryByRole("button", { name: /comments in code$/ })).toBeNull();
  fireEvent.click(band(slot).getByRole("button", { name: "Diff options" }));
  expect(await slot.findByRole("switch", { name: "Fold comments in code" })).toBeTruthy();
  expect(slot.getByRole("radiogroup", { name: "Show changes" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("where the band has no room for the compare select, as in full screen beside the review's commands, a narrowed diff says so above its files", async () => {
  fakePane(1000, 900, 220);
  const slot = await renderWorkspace(rereview);
  expect(band(slot).queryByRole("button", { name: /^Show changes/ })).toBeNull();
  fireEvent.click(band(slot).getByRole("button", { name: "Diff options" }));
  fireEvent.click(within(await slot.findByRole("radiogroup", { name: "Show changes" })).getByRole("radio", { name: "Since your review" }));
  expect((await slot.findByText(/^Showing changes since your review/)).textContent).toBe("Showing changes since your review · 1 of 2 files");
  slot.lifecycle.unmount();
});

test("with the compare select in the band, a narrowed diff says so there alone", async () => {
  fakePane(1400);
  const slot = await renderWorkspace(rereview);
  fireEvent.click(await band(slot).findByRole("button", { name: "Show changes: All changes" }));
  fireEvent.click(await slot.findByRole("menuitemradio", { name: /^Since your review/ }));
  expect(await band(slot).findByRole("button", { name: "Show changes: Since your review" })).toBeTruthy();
  expect(slot.getAllByTestId("filediff")).toHaveLength(1);
  expect(slot.queryByText(/^Showing changes since/)).toBeNull();
  slot.lifecycle.unmount();
});

test("Fold comments in the band folds every comment in the code to a marker, and unfolds them, for every review", async () => {
  fakePane(1400);
  const slot = await renderWorkspace();
  fireEvent.click(band(slot).getByRole("button", { name: "Fold comments in code" }));
  expect(getCommentsFolded()).toBe(true);
  fireEvent.click(band(slot).getByRole("button", { name: "Unfold comments in code" }));
  expect(getCommentsFolded()).toBe(false);
  slot.lifecycle.unmount();
});

test("on the Overview the band says so, with nothing about how the diff draws", async () => {
  fakePane(1400);
  const slot = await renderWorkspace(rereview);
  act(() => { fireEvent.keyDown(document.body, { key: "p" }); });
  await band(slot).findByText("Overview");
  expect(band(slot).queryByRole("button", { name: "Diff options" })).toBeNull();
  expect(band(slot).queryByRole("button", { name: /^Show changes/ })).toBeNull();
  expect(band(slot).queryByRole("button", { name: /comments in code$/ })).toBeNull();
  slot.lifecycle.unmount();
});
