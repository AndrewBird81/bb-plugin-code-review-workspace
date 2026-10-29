// @vitest-environment jsdom
// Which review you're in, at a glance (lib/review-identity.ts): BB's title bar and the window's title, the band's id
// chip, the page bar, the hero's rename, the phone's dock, the agent's widget and BB's thread list.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render as draw, renderHook, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import { reviewIdentity } from "../lib/review-identity";
import { publishReviewTitle, useReviewTitle } from "../lib/workspace-store";
import { bandFit, chipWidth } from "./reading/ReaderBar";
import { ID_CHIP, ReviewIdChip } from "./ReviewIdChip";
import { middleCut } from "./shell/PhoneDock";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre data-testid="filediff">{fileDiff.additionLines.join("\n")}</pre> }));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); restores.splice(0).forEach((restore) => restore()); });

/**
 * Every ResizeObserver reports `width` × `height`, and the band its `room`; `phone`: media queries answer for a phone's
 * screen too.
 */
function pane(width: number, { height = 900, phone = false, room = width, dockId = width }: { height?: number; phone?: boolean; room?: number; dockId?: number } = {}) {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) {
      const band = !!target.querySelector(":scope > nav[aria-label='Breadcrumb']");
      const id = target.matches("[data-dock-id]");
      this.notify([{ target, contentRect: { width: band ? room : id ? dockId : width, height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const matchMedia = phone ? vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const max = query.match(/max-(width|height): (\d+)px/);
    return { matches: !!max && (max[1] === "width" ? width : height) <= Number(max[2]), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as MediaQueryList;
  }) : null;
  restores.push(() => { globalThis.ResizeObserver = original; matchMedia?.mockRestore(); });
}

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+aa\n";
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }] }] };
const pr = { kind: "pr", repo: "flosports/api", number: 4512, title: "Fix login race", author: "dana", status: "ready", createdAt: 1, headSha: "new" };

function rpc(reviews: Record<string, Record<string, unknown> | null>, rename = vi.fn((_input: unknown) => ({ ok: true }))) {
  return {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: ({ targetKey }: { targetKey: string }) => {
      const review = reviews[targetKey];
      return { review: review && { targetKey, ...review }, guide: review?.status === "ready" ? structuredClone(guide) : null, patch, revision: "r1" };
    },
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "flosports/api", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: ({ targetKey }: { targetKey: string }) => ({ draft: { targetKey, verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    listReviews: () => ({ reviews: [] }),
    renameReview: rename,
  } as any;
}

/** The panel at `subPath`, in a host with page titles unless `untitled`, as BB's from before them. */
async function render(subPath: string, reviews: Record<string, Record<string, unknown> | null>, rename?: ReturnType<typeof vi.fn>, untitled = false) {
  const app = await loadPluginApp(() => import("../app"));
  const panel = app.navPanels[0]!;
  return renderSlot(untitled ? { component: panel.component } : panel, { subPath }, { rpc: rpc(reviews, rename) });
}

test("BB's title bar and the window's title lead with the open review's id, its name after, a crumb BB cuts first; All reviews and Settings keep the panel's name", async () => {
  pane(1400);
  patchReviewState("pr-1", { activeId: "c1" });
  const review = await render("pr-1", { "pr-1": pr });
  await review.findAllByTestId("filediff");
  await waitFor(() => expect(review.experimental_pageTitle).toEqual({ breadcrumbs: [{ label: "api#4512" }, { label: "Fix login race" }], windowTitle: "api#4512 · Fix login race" }));
  // Two panes, each its own review, each its own title.
  const other = await render("ref-1", { "ref-1": { kind: "ref", gitRef: "main...bb/snooze-checks-thr_ab12", cwd: "/Users/ana/src/web", name: "Snoozing", status: "ready", createdAt: 1, place: { repo: "flosports/web", machine: "MaxBook", path: "/Users/ana/src/web" } } });
  await other.findAllByTestId("filediff");
  await waitFor(() => expect(other.experimental_pageTitle).toMatchObject({ breadcrumbs: [{ label: "web:snooze-checks" }, { label: "Snoozing" }], windowTitle: "web:snooze-checks · Snoozing" }));
  expect(review.experimental_pageTitle).toMatchObject({ windowTitle: "api#4512 · Fix login race" });
  review.lifecycle.unmount();
  other.lifecycle.unmount();
  for (const subPath of ["", "settings/pr-1"]) {
    const page = await render(subPath, {});
    expect(page.experimental_pageTitle, subPath).toBeNull();
    page.lifecycle.unmount();
  }
});

test("a review without a guide yet, found on GitHub or building, has its title too, and its bar's heading says it whole", async () => {
  pane(1400);
  for (const status of ["tracked", "generating"]) {
    const page = await render("pr-1", { "pr-1": { ...pr, status } });
    // What a screen reader hears starts with the id as it shows.
    const heading = await page.findByRole("heading", { level: 1, name: "api#4512 Fix login race" });
    expect(heading.querySelector("[data-review-id]")!.getAttribute("title")).toBe("flosports/api#4512 · Fix login race");
    await waitFor(() => expect(page.experimental_pageTitle).toMatchObject({ windowTitle: "api#4512 · Fix login race" }));
    page.lifecycle.unmount();
  }
});

test("the band keeps the id's chip at 480px, the review's title giving way first; the review's landmark names it whole", async () => {
  const chip = chipWidth(reviewIdentity(pr as any));
  // A tablet's band with the chapters over the code: their toggle, Find, ‹, Fold and Diff options at 44px.
  expect(bandFit(480, 5, 44, null, { chip })).toMatchObject({ back: false, title: false });
  // The title only where the whole breadcrumb fits beside it; in full screen, where BB's title bar doesn't name the
  // review, before All reviews.
  expect(bandFit(1100, 3, 32, null, { chip })).toMatchObject({ back: true, title: true });
  expect(bandFit(700, 3, 32, null, { chip })).toMatchObject({ back: false, title: false });
  expect(bandFit(700, 3, 32, null, { chip, named: true })).toMatchObject({ back: false, title: true });
  // A tablet's pane, its band 480px beside the docked sides.
  pane(1200, { room: 480 });
  patchReviewState("pr-1", { activeId: "c1" });
  const slot = await render("pr-1", { "pr-1": pr });
  await slot.findAllByTestId("filediff");
  const crumbs = within(slot.getByRole("navigation", { name: "Breadcrumb" }));
  // Its name is the id it shows, the whole review its description.
  const crumb = crumbs.getByRole("button", { name: "api#4512", description: "Pull request 4512 in flosports/api: Fix login race, by dana" });
  expect(crumb.querySelector("[data-review-id]")!.getAttribute("title")).toBe("flosports/api#4512 · Fix login race");
  expect(within(crumb).queryByText("Fix login race")).toBeNull();
  expect(crumbs.getByText("Chapter 1 of 1: Parsing, 0 of 1 files viewed")).toBeTruthy();
  expect(slot.getByRole("main", { name: "Review: Pull request 4512 in flosports/api: Fix login race, by dana" })).toBeTruthy();
  // It goes to the Overview, which keeps the chip.
  fireEvent.click(crumb);
  await within(slot.getByRole("navigation", { name: "Breadcrumb" })).findByText("Overview");
  expect(within(slot.getByRole("navigation", { name: "Breadcrumb" })).getByText("api#4512", { selector: ".sr-only" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("the band leaves the review's name to BB's title bar where that shows it, and has it after the id where it doesn't", async () => {
  pane(1600);
  patchReviewState("pr-1", { activeId: "c1" });
  for (const untitled of [false, true]) {
    const slot = await render("pr-1", { "pr-1": { ...pr, name: "Login race" } }, undefined, untitled);
    await slot.findAllByTestId("filediff");
    const crumbs = within(slot.getByRole("navigation", { name: "Breadcrumb" }));
    const crumb = await crumbs.findByRole("button", { name: untitled ? "api#4512 Login race" : "api#4512" });
    expect(!!within(crumb).queryByText("Login race"), String(untitled)).toBe(untitled);
    slot.lifecycle.unmount();
  }
});

test("the Overview's title renames the review in place: Enter saves, Esc leaves it, and your own PR says Yours", async () => {
  pane(1400);
  const rename = vi.fn((_input: unknown) => ({ ok: true }));
  const slot = await render("pr-1", { "pr-1": { ...pr, author: "me", ownPr: true } }, rename);
  const main = within(await slot.findByRole("main", { name: /^Review/ }));
  await main.findByRole("heading", { name: "Fix login race" });
  expect(main.getByText("Yours")).toBeTruthy();
  fireEvent.click(main.getByRole("button", { name: "Rename review" }));
  let box = main.getByRole("textbox", { name: "Review name" }) as HTMLInputElement;
  expect(box.value).toBe("Fix login race");
  fireEvent.keyDown(box, { key: "Escape" });
  expect(main.queryByRole("textbox", { name: "Review name" })).toBeNull();
  expect(rename).not.toHaveBeenCalled();
  fireEvent.click(main.getByRole("button", { name: "Rename review" }));
  box = main.getByRole("textbox", { name: "Review name" }) as HTMLInputElement;
  fireEvent.change(box, { target: { value: "  Login race " } });
  fireEvent.submit(box.closest("form")!);
  await waitFor(() => expect(rename).toHaveBeenCalledWith({ targetKey: "pr-1", name: "Login race" }));
  await waitFor(() => expect(main.queryByRole("textbox", { name: "Review name" })).toBeNull());
  // Emptied, it goes back to the PR's title; leaving the box saves it once.
  fireEvent.click(main.getByRole("button", { name: "Rename review" }));
  box = main.getByRole("textbox", { name: "Review name" }) as HTMLInputElement;
  fireEvent.change(box, { target: { value: "" } });
  fireEvent.blur(box);
  await waitFor(() => expect(rename).toHaveBeenLastCalledWith({ targetKey: "pr-1", name: "" }));
  expect(rename).toHaveBeenCalledTimes(2);
  slot.lifecycle.unmount();
});

test("a local review's Overview says it's Local, where its checkout is, its id, and its range as a PR's branches", async () => {
  pane(1400);
  const slot = await render("ref-1", { "ref-1": { kind: "ref", gitRef: "main...bb/snooze-checks-thr_ab12", cwd: "/Users/ana/src/web", status: "ready", createdAt: 1, place: { repo: "flosports/web", machine: "MaxBook", path: "/Users/ana/src/web" } } });
  const main = within(await slot.findByRole("main", { name: "Review: Local review of snooze-checks in flosports/web: Guide, on MaxBook in ~/src/web" }));
  const hero = within(main.getByRole("heading", { level: 2, name: "Guide" }).closest("header")!);
  for (const fact of ["Local", "MaxBook · ~/src/web", "web:snooze-checks", "main", "snooze-checks", "snooze-checks into main"]) expect(hero.getByText(fact), fact).toBeTruthy();
  expect(hero.queryByText("main...bb/snooze-checks-thr_ab12")).toBeNull();
  slot.lifecycle.unmount();
});

test("on a phone, the dock's chapter tab has the review's id over the chapter, and BB's narrow title bar the line as one title, as its crumbs would run into each other", async () => {
  pane(390, { height: 844, phone: true });
  patchReviewState("pr-1", { activeId: "c1" });
  const slot = await render("pr-1", { "pr-1": pr });
  await slot.findAllByTestId("filediff");
  await waitFor(() => expect(slot.experimental_pageTitle).toEqual({ title: "api#4512 · Fix login race", windowTitle: "api#4512 · Fix login race" }));
  // Its name starts with the id it shows.
  const tab = within(slot.getByRole("group", { name: "Review commands" })).getByRole("button", { name: "api#4512, Chapters: Chapter 1 of 1, Parsing, 0 of 1 files viewed" });
  // After the chapter's ring: the id, once for a screen reader and once drawn, then the chapter.
  expect(tab.textContent).toMatch(/api#4512api#4512Parsing$/);
  slot.lifecycle.unmount();
});

// BB's own colors, as its app's stylesheet sets them (0.47.1's index-*.css): achromatic OKLCH lightness, where a
// color-mix of two is the mix of their lightness. Luminance is lightness cubed.
const THEMES = {
  light: { canvas: 1, ink: 0.3211, muted: 0.44 },
  dark: { canvas: 0.195, ink: 0.81, muted: 0.78 },
};
const mix = (theme: typeof THEMES.light, inkShare: number) => theme.canvas + (theme.ink - theme.canvas) * inkShare;
const contrast = (a: number, b: number) => { const [hi, lo] = [a ** 3, b ** 3].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test("an id's muted text keeps 4.5:1 or more on every surface it sits on, in both themes", () => {
  expect(ID_CHIP).toContain("text-muted-foreground");
  expect(ID_CHIP).toContain("bg-muted");
  for (const [name, theme] of Object.entries(THEMES)) {
    // The page and cards, the chip's muted fill (11% and 16% ink), and BB's thread list (2.2% and 4.3%).
    for (const surface of [theme.canvas, mix(theme, 0.11), mix(theme, 0.16), mix(theme, 0.022), mix(theme, 0.043)]) {
      expect(contrast(theme.muted, surface), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("a long repository's chip cuts only its name, never the PR's number, and says the whole id on hover and to a screen reader", () => {
  const identity = reviewIdentity({ targetKey: "pr-1", kind: "pr", repo: "get-bb/bb-plugin-code-review-workspace", number: 123, title: "Fix" });
  const { container } = draw(<ReviewIdChip identity={identity} />);
  const chip = container.querySelector<HTMLElement>("[data-review-id]")!;
  expect(chip.getAttribute("title")).toBe("get-bb/bb-plugin-code-review-workspace#123 · Fix");
  const [spoken, repo, tail] = Array.from(chip.children) as HTMLElement[];
  expect([spoken.className, spoken.textContent]).toEqual(["sr-only", "bb-plugin-code-review-workspace#123"]);
  expect(repo.className.split(" ")).toEqual(expect.arrayContaining(["truncate", "min-w-0"]));
  expect(tail.textContent).toBe("#123");
  expect(tail.className.split(" ")).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
  expect(tail.className).not.toContain("truncate");
  // The band reserves the number whole, and the name at most 160px.
  expect(chipWidth(identity)).toBe(160 + Math.ceil(4 * 6.6) + 18);
});

test("two panes on one review keep its title until the last of them closes", () => {
  const title = { id: "api#9", name: "One", line: "api#9 · One" };
  const first = publishReviewTitle("pr-9", title);
  const second = publishReviewTitle("pr-9", { ...title });
  const { result, rerender } = renderHook(() => useReviewTitle("pr-9")?.line ?? null);
  expect(result.current).toBe("api#9 · One");
  second();
  rerender();
  expect(result.current).toBe("api#9 · One");
  first();
  rerender();
  expect(result.current).toBeNull();
});

test("a local review goes by one name everywhere: its row, BB's thread list, its Overview and its title all take its guide's title", async () => {
  pane(1400);
  const turn = { group: "needs", reason: "requested", label: "", signal: null, at: Date.now() - 60_000, notify: false, blocking: false, updated: false, eventAt: null, failed: false };
  const local = { kind: "ref", gitRef: "main...bb/snooze-checks-thr_ab12", cwd: "/Users/ana/src/web", status: "ready", createdAt: 1, turn,
    guideTitle: "Guide", place: { repo: "flosports/web", machine: "MaxBook", path: "/Users/ana/src/web" } };
  const app = await loadPluginApp(() => import("../app"));
  const reviews = [{ targetKey: "ref-1", ...local }];
  const settings = { preferences: { ...defaultPreferences, threadListReviews: true }, revision: 0 };
  // All reviews' row.
  const list = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { ...rpc({}), listReviews: () => ({ reviews }), refreshReviews: () => ({ reviews }), getPreferences: () => settings, listFilterViews: () => ({ views: [] }), getSetupStatus: () => ({ githubCli: true, account: "me", agentAvailable: true, projectAvailable: true }) } });
  const row = (await list.findByText("Guide")).closest("button")!;
  expect(within(row).getAllByText("web:snooze-checks").length).toBeGreaterThan(0);
  list.lifecycle.unmount();
  // BB's thread list.
  document.body.insertAdjacentHTML("beforeend", `<div data-bb-plugin-root data-bb-plugin="thread-list"><div><div data-sidebar-visibility-group="threads"><div data-sidebar-sticky-group><div data-sidebar="group-label">Threads</div></div></div></div></div>`);
  const sidebar = renderSlot(app.appOverlays.find((overlay) => overlay.id === "needs-review")!, {}, { rpc: { listReviews: () => ({ reviews }), pinReview: () => ({ ok: true }), getPreferences: () => settings }, sidebarThreads: { status: "ready", threads: [] } });
  expect(await within(document.body).findByRole("link", { name: /^Guide/ })).toBeTruthy();
  sidebar.lifecycle.unmount();
  document.body.innerHTML = "";
  // Its Overview and BB's title bar.
  const page = await render("ref-1", { "ref-1": local });
  expect(await page.findByRole("heading", { level: 2, name: "Guide" })).toBeTruthy();
  await waitFor(() => expect(page.experimental_pageTitle).toMatchObject({ breadcrumbs: [{ label: "web:snooze-checks" }, { label: "Guide" }] }));
  page.lifecycle.unmount();
});

test("on a phone, a local review's long id is cut in the middle to the dock's room, both its ends showing, and whole on hover and to a screen reader", async () => {
  const id = "web:feature/snooze-flaky-checks-on-retries";
  expect(id).toHaveLength(42);
  expect(middleCut(id, 16)).toBe("web:fe…n-retries");
  expect(middleCut(id, 42)).toBe(id);
  // About 110px of tab, as at 390px: 16 characters at 6.6px.
  pane(390, { height: 844, phone: true, dockId: 110 });
  patchReviewState("ref-9", { activeId: "c1" });
  const slot = await render("ref-9", { "ref-9": { kind: "ref", gitRef: "main...feature/snooze-flaky-checks-on-retries", cwd: "/src/web", status: "ready", createdAt: 1, place: { repo: "flosports/web", path: "/src/web" } } });
  await slot.findAllByTestId("filediff");
  const tab = within(slot.getByRole("group", { name: "Review commands" })).getByRole("button", { name: `${id}, Chapters: Chapter 1 of 1, Parsing, 0 of 1 files viewed` });
  const shown = tab.querySelector<HTMLElement>("[data-dock-id]")!;
  expect(shown.getAttribute("title")).toBe(id);
  expect(within(shown).getByText(id).className).toBe("sr-only");
  expect(within(shown).getByText("web:fe…n-retries").getAttribute("aria-hidden")).toBe("true");
  slot.lifecycle.unmount();
});

test("tabbing out of the rename box past its ✓ ends renaming as leaving it does: a changed name saves, an unchanged one closes", async () => {
  pane(1400);
  const rename = vi.fn((_input: unknown) => ({ ok: true }));
  const slot = await render("pr-1", { "pr-1": pr }, rename);
  const main = within(await slot.findByRole("main", { name: /^Review/ }));
  for (const [typed, saved] of [["Fix login race", false], ["Login race", true]] as const) {
    fireEvent.click(await main.findByRole("button", { name: "Rename review" }));
    const box = main.getByRole("textbox", { name: "Review name" });
    fireEvent.change(box, { target: { value: typed } });
    const save = main.getByRole("button", { name: "Save name" });
    // Tab to ✓: still renaming.
    fireEvent.blur(box, { relatedTarget: save });
    expect(main.getByRole("textbox", { name: "Review name" })).toBe(box);
    // Tab on, out of the box's group.
    fireEvent.blur(save, { relatedTarget: document.body });
    await waitFor(() => expect(main.queryByRole("textbox", { name: "Review name" })).toBeNull());
    expect(rename.mock.calls.length, typed).toBe(saved ? 1 : 0);
  }
  expect(rename).toHaveBeenCalledWith({ targetKey: "pr-1", name: "Login race" });
  slot.lifecycle.unmount();
});
