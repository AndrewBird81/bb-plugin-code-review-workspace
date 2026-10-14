// For tests, not the plugin: a PR review and All reviews with chosen settings knobs, for checking what each view does
// with them off. Each render loads the plugin first; a test file using it mocks @pierre/diffs/react, which jsdom can't run.
import { vi } from "vitest";
import { within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultKnobs, KNOB_RANGES, type Knobs } from "../lib/knobs";
import { defaultPreferences } from "../lib/review-preferences";

/** Every toggle off, and the pace at its minimum. */
export const allKnobsOff: Knobs = {
  ...Object.fromEntries(Object.entries(defaultKnobs).map(([id, value]) => [id, typeof value === "boolean" ? false : value])) as unknown as Knobs,
  approveGuardPace: KNOB_RANGES.approveGuardPace.min,
};

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n"
  + "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-{}\n+{ }\n";
const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[],
  requirements: [{ text: "Parse upper case rows", status: "covered", evidence: "Reads TWO.", file: "src/a.ts", line: 2 }],
  sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", risk: "high", diffs: [{ file: "src/a.ts", summary: "Reads a row." }, { file: "package-lock.json", summary: "Lockfile." }] }],
};
const comments = [{ file: "src/a.ts", line: 2, side: "RIGHT", severity: "blocking", body: "Upper case reads as a constant." }];

/** The RPCs a PR review and All reviews call, with the settings' knobs; `rpc` replaces any of them. */
export function settingsOffRpc(knobs: Knobs, rpc: Record<string, unknown> = {}) {
  const review = { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", url: "https://github.com/acme/web/pull/42", repo: "acme/web", number: 42 };
  return {
    setReviewPresence: () => ({ ok: true }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs }, revision: 1 }),
    getReviewBundle: () => ({ review, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "fail", checks: [{ name: "test", bucket: "fail", state: "FAILURE", link: "https://github.com/acme/web/runs/1" }] }),
    getCheckFailures: () => ({ failures: [{ file: "src/a.ts", line: 2, check: "lint", title: "no-shout", message: "Lower-case it.", url: "https://github.com/acme/web/runs/1" }] }),
    getCodeOwners: () => ({ files: [{ file: "src/a.ts", owners: ["@acme/parsers"], mine: true }] }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: structuredClone(comments) }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    getReviewThreads: () => ({ threads: [] }),
    getReplyDrafts: () => ({ drafts: [] }),
    markSeen: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    getSetupStatus: () => ({ account: "me", githubCli: true, agentAvailable: true, projectAvailable: true }),
    listReviews: () => ({ reviews: [review] }),
    refreshReviews: () => ({ reviews: [review] }),
    ...rpc,
  };
}

/** A 1400 × 900 window, where BB's title bar shows the review's commands; returns its undo. */
export function desktopWindow(): () => void {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) { this.notify([{ target, contentRect: { width: 1400, height: 900 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const max = query.match(/max-(width|height): (\d+)px/);
    const matches = !!max && (max[1] === "width" ? 1400 : 900) <= Number(max[2]);
    return { matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as MediaQueryList;
  });
  const root = document.documentElement;
  Object.defineProperty(root, "clientWidth", { configurable: true, value: 1400 });
  Object.defineProperty(root, "clientHeight", { configurable: true, value: 900 });
  return () => { globalThis.ResizeObserver = original; matchMedia.mockRestore(); delete (root as { clientWidth?: number }).clientWidth; delete (root as { clientHeight?: number }).clientHeight; };
}

/** The review's page on its Overview, and BB's title bar as the host renders it, apart from the page. */
export async function renderReview(knobs: Knobs, rpc: Record<string, unknown> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const registration = app.navPanels[0]!;
  const bar = renderSlot({ component: registration.headerContent! }, { subPath: "pr-42" }, { rpc: settingsOffRpc(knobs, rpc) as any });
  const page = renderSlot(registration, { subPath: "pr-42" }, { rpc: settingsOffRpc(knobs, rpc) as any });
  await page.findByRole("main", { name: "Review" });
  return { page, bar, main: () => within(page.getByRole("main", { name: "Review" })) };
}

/** All reviews. */
export async function renderInbox(knobs: Knobs, rpc: Record<string, unknown> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const page = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: settingsOffRpc(knobs, rpc) as any });
  await page.findByText("Parse rows");
  return page;
}
