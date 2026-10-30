// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import { TOUCH_CONTROL } from "./touch";
import type { FeatureCheck } from "../src/feature-review";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const KEY = "br-1";
const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n";
const guide = { title: "Snooze flaky checks", intent: "Snoozes checks.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Snooze", overview: "", diffs: [{ file: "src/a.ts" }] }] };
const feature = { environmentId: "env1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/src/api", branch: "bb/snooze-checks-thr_ab12", baseRef: "main", repo: "acme/api" };
const local = { targetKey: KEY, kind: "ref", gitRef: feature.branch, status: "ready", createdAt: 1, title: "Snooze flaky checks", feature, mainThread: { threadId: "main", environmentId: "env1", origin: "adopted", since: 1 } };
const nothing: FeatureCheck = { state: "current", alsoActive: [], hidden: [], flagged: [] };

async function renderWorkspace(rpc: Record<string, unknown>, review: Record<string, unknown> = local, knobs: Record<string, boolean> = {}) {
  patchReviewState(KEY, { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: vi.fn(() => ({ review, guide: structuredClone(guide), patch, revision: "r1" })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultPreferences.knobs, ...knobs } }, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/api", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: KEY, verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getGhAccounts: () => ({ active: "me", accounts: [{ login: "me", active: true }] }),
    getSourceThread: () => ({ thread: null }),
    markSeen: () => ({ ok: true }),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: KEY }, { rpc: handlers as any });
  await slot.findByTestId("filediff");
  return { slot, rpc: handlers };
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];
const notice = (slot: Slot, text: string | RegExp) => slot.getByText(text).closest<HTMLElement>("[role]")!;

test("a changed folder says how many files, and Update reads it again without the guide writer", async () => {
  const checkFeature = vi.fn(() => ({ ...nothing, state: "changed", changedFiles: 3 }));
  const updateFeature = vi.fn(() => ({ ok: true }));
  const { slot, rpc } = await renderWorkspace({ checkFeature, updateFeature });
  const text = "3 files changed since your last update.";
  await slot.findByText(text);
  expect(notice(slot, text).querySelector("svg")?.getAttribute("data-icon")).toBe("FileDiff");
  const update = within(notice(slot, text)).getByRole("button", { name: "Update" });
  expect(update.className.split(" ")).toEqual(expect.arrayContaining(TOUCH_CONTROL.split(" ")));
  fireEvent.click(update);
  await waitFor(() => expect(updateFeature).toHaveBeenCalledWith({ targetKey: KEY }));
  // The review reads itself again: the updated diff.
  await waitFor(() => expect(rpc.getReviewBundle.mock.calls.length).toBeGreaterThan(1));
  expect(slot.queryByRole("button", { name: "Update guide" })).toBeNull();
  // Its folder is asked about again when the review, or the folder, changes.
  await slot.emitRealtime(`folder:${KEY}`, {});
  await waitFor(() => expect(checkFeature.mock.calls.length).toBeGreaterThan(1));
  slot.lifecycle.unmount();
});

test("with Say when the code changed off, a changed folder says nothing", async () => {
  const { slot } = await renderWorkspace({ checkFeature: () => ({ ...nothing, state: "changed", changedFiles: 3 }) }, local, { localDiffChanges: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(slot.queryByText(/changed since your last update/)).toBeNull();
  slot.lifecycle.unmount();
});

test("a folder on another branch pauses the review: Follow that branch or a New review for it, or Open its review once it has one", async () => {
  const reviewFolderBranch = vi.fn(() => ({ ok: true, targetKey: "br-2" }));
  const followFolderBranch = vi.fn(() => ({ ok: true }));
  const { slot } = await renderWorkspace({ checkFeature: () => ({ ...nothing, state: "paused", branch: "bb/fix-docs-thr_cd34" }), reviewFolderBranch, followFolderBranch });
  const paused = await slot.findByRole("status", { name: "Review paused" });
  expect(paused.textContent).toContain("Folder is on fix-docs. This review waits for snooze-checks.");
  // A branch's name never breaks across lines.
  expect(within(paused).getByText("fix-docs").className).toContain("whitespace-nowrap");
  fireEvent.click(within(paused).getByRole("button", { name: "Follow fix-docs" }));
  await waitFor(() => expect(followFolderBranch).toHaveBeenCalledWith({ targetKey: KEY }));
  fireEvent.click(within(paused).getByRole("button", { name: "New review for fix-docs" }));
  await waitFor(() => expect(reviewFolderBranch).toHaveBeenCalledWith({ targetKey: KEY }));
  slot.lifecycle.unmount();
  cleanup();

  const opening = vi.fn();
  const existing = await renderWorkspace({ checkFeature: () => ({ ...nothing, state: "paused", branch: "bb/fix-docs-thr_cd34", branchReview: "br-2" }), reviewFolderBranch: opening });
  fireEvent.click(within(await existing.slot.findByRole("status", { name: "Review paused" })).getByRole("button", { name: "Open fix-docs review" }));
  expect(opening).not.toHaveBeenCalled();
  existing.slot.lifecycle.unmount();
});

test("a review that followed its renamed branch says so, with Got it", async () => {
  const dismissFollowed = vi.fn(() => ({ ok: true }));
  const { slot } = await renderWorkspace({ checkFeature: () => nothing, dismissFollowed }, { ...local, followed: { from: "feat/qa", branch: "feat/nice", at: 1 } });
  const followed = await slot.findByRole("status", { name: "Branch renamed" });
  expect(followed.textContent).toContain("Now following feat/nice.");
  fireEvent.click(within(followed).getByRole("button", { name: "Got it" }));
  await waitFor(() => expect(dismissFollowed).toHaveBeenCalledWith({ targetKey: KEY }));
  slot.lifecycle.unmount();
});

test("an offline machine is said calmly, with Check again", async () => {
  const asking = vi.fn(() => ({ ...nothing, state: "offline", message: "MaxBook is offline." }));
  const offline = await renderWorkspace({ checkFeature: asking });
  const asleep = (await offline.slot.findByText("MaxBook is offline. This is the folder as last read.")).closest<HTMLElement>("[role]")!;
  expect(asleep.querySelector("svg")?.getAttribute("data-icon")).toBe("WifiOff");
  expect(asleep.className).not.toContain("warning");
  fireEvent.click(within(asleep).getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(asking.mock.calls.length).toBeGreaterThan(1));
  offline.slot.lifecycle.unmount();
});

test("a removed folder says so, with Archive until it's archived", async () => {
  const archiveReview = vi.fn(() => ({ ok: true }));
  const { slot } = await renderWorkspace({ checkFeature: () => ({ ...nothing, state: "gone" }), archiveReview }, { ...local, feature: { ...feature, folderGone: true } });
  // Its main thread worked there: a Send starts a fresh one.
  const text = "BB removed this folder. The review keeps its last changes and your comments. Your next Send starts a fresh thread from snooze-checks.";
  await slot.findByText(text);
  fireEvent.click(within(notice(slot, text)).getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(archiveReview).toHaveBeenCalledWith({ targetKey: KEY, archived: true }));
  slot.lifecycle.unmount();
  cleanup();
  const archived = await renderWorkspace({ checkFeature: () => ({ ...nothing, state: "gone" }) }, { ...local, archivedAt: 5, feature: { ...feature, folderGone: true } });
  const done = notice(archived.slot, await archived.slot.findByText("BB removed this folder. The review keeps its last changes.").then((el) => el.textContent!));
  expect(within(done).queryByRole("button")).toBeNull();
  archived.slot.lifecycle.unmount();
});

test("Changed leads the rest; Got it quiets a committed secret; each secret is sent only by a button naming it, and binaries by Include", async () => {
  const includeHidden = vi.fn(() => ({ ok: true }));
  const dismissFlagged = vi.fn(() => ({ ok: true }));
  const check: FeatureCheck = {
    ...nothing, state: "changed", changedFiles: 2,
    hidden: [{ path: ".env.local", reason: "secret" }, { path: "certs/dev.pem", reason: "secret" }, { path: "logo.png", reason: "binary" }, { path: "dump.sql", reason: "large" }],
    flagged: ["config/.env.production"],
    alsoActive: [{ threadId: "thr_docs", title: "Fix the docs" }],
  };
  const offer = { key: "pr-abc-7", number: 7, url: "https://github.com/acme/api/pull/7", moves: { comments: 1, summary: false, sends: 0 } };
  const { slot } = await renderWorkspace({ checkFeature: () => check, includeHidden, dismissFlagged }, { ...local, prOffer: offer });
  // The banner needed on every visit leads, the rest under +N.
  await slot.findByText("2 files changed since your last update.");
  expect(slot.queryByText("config/.env.production looks like a secret and is committed. Check it belongs in the repo.")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "6 more notices" }));
  const order = Array.from(document.querySelectorAll<HTMLElement>("[aria-live=polite] > [role]")).map((row) => row.getAttribute("aria-label") ?? row.textContent!.slice(0, 20));
  expect(order).toEqual(["Folder changed", "config/.env.producti", "PR #7 has a review o", "File not shown", "File not shown", "Files not shown", "Also editing this folder"]);
  fireEvent.click(within(notice(slot, "config/.env.production looks like a secret and is committed. Check it belongs in the repo.")).getByRole("button", { name: "Got it" }));
  await waitFor(() => expect(dismissFlagged).toHaveBeenCalledWith({ targetKey: KEY, files: ["config/.env.production"] }));
  fireEvent.click(within(notice(slot, ".env.local looks like a secret, so it isn’t shown or sent to agents.")).getByRole("button", { name: "Send .env.local to agents" }));
  await waitFor(() => expect(includeHidden).toHaveBeenCalledWith({ targetKey: KEY, files: [".env.local"], included: true }));
  // Its name whole on the button, its path in the text, the hover and the button's name.
  const pem = within(notice(slot, "certs/dev.pem looks like a secret, so it isn’t shown or sent to agents.")).getByRole("button", { name: "Send dev.pem to agents (certs/dev.pem)" });
  expect(pem.textContent).toBe("Send dev.pem to agents");
  expect(within(pem).getByText("Send dev.pem to agents").getAttribute("title")).toBe("certs/dev.pem");
  expect(pem.className).not.toContain("max-w-64");
  const rest = notice(slot, "2 files aren’t shown: logo.png and dump.sql.");
  fireEvent.click(within(rest).getByRole("button", { name: "Include logo.png" }));
  await waitFor(() => expect(includeHidden).toHaveBeenLastCalledWith({ targetKey: KEY, files: ["logo.png"], included: true }));
  const active = slot.getByRole("status", { name: "Also editing this folder" });
  expect(active.textContent).toBe("Fix the docs is also editing this folder; its changes are in this review.Fix the docs ↗");
  expect(within(active).getByRole("button", { name: "Fix the docs" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("other threads editing the folder: the first named, the rest listed from “N more”", async () => {
  const check: FeatureCheck = { ...nothing, alsoActive: [{ threadId: "thr_docs", title: "Fix the docs" }, { threadId: "thr_deps", title: "Bump deps" }, { threadId: "thr_ci", title: "Fix CI" }] };
  const { slot } = await renderWorkspace({ checkFeature: () => check });
  const active = await slot.findByRole("status", { name: "Also editing this folder" });
  // Beside the others, Open names the one it opens.
  expect(active.textContent).toBe("Fix the docs and 2 more are also editing this folder; their changes are in this review.Fix the docs ↗");
  fireEvent.click(within(active).getByRole("button", { name: "2 more" }));
  const list = await within(document.body).findByRole("list", { name: "Also editing this folder" });
  expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual(["Bump deps", "Fix CI"]);
  slot.lifecycle.unmount();
});

test("a review that isn't of a folder, or became its PR's and lost its folder, asks nothing about one", async () => {
  const checkFeature = vi.fn(() => nothing);
  const pr = await renderWorkspace({ checkFeature }, { ...local, kind: "pr", repo: "acme/api", number: 7, headSha: "c0ffee", feature: { ...feature, folderGone: true } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  pr.slot.lifecycle.unmount();
  cleanup();
  const ref = await renderWorkspace({ checkFeature }, { targetKey: KEY, kind: "ref", gitRef: "HEAD", cwd: "/repo", status: "ready", createdAt: 1 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(checkFeature).not.toHaveBeenCalled();
  ref.slot.lifecycle.unmount();
});

test("after Update, a guide written before it says so, after Changed, with Rewrite guide, which says it starts the guide writer", async () => {
  const rewriteGuide = vi.fn(() => ({ ok: true }));
  const review = { ...local, feature: { ...feature, guideOlderThanDiff: "update" } };
  const { slot } = await renderWorkspace({ checkFeature: () => ({ ...nothing, state: "changed", changedFiles: 1 }), rewriteGuide }, review);
  const text = "The guide was written before your last Update.";
  // Changed first: it's what Update answers.
  const more = await slot.findByRole("button", { name: "1 more notice" });
  const shown = within(more.closest<HTMLElement>("[aria-live]")!);
  fireEvent.click(more);
  await slot.findByText(text);
  expect(shown.getAllByRole("status").map((row) => row.getAttribute("aria-label"))).toEqual(["Folder changed", "Guide out of date"]);
  const rewrite = within(notice(slot, text)).getByRole("button", { name: "Rewrite guide" });
  expect(rewrite.getAttribute("aria-description")).toBe("Starts the guide writer to write a new guide for the code now.");
  expect(rewrite.querySelector("svg")?.getAttribute("data-icon")).toBe("Sparkles");
  fireEvent.click(rewrite);
  await waitFor(() => expect(rewriteGuide).toHaveBeenCalledWith({ targetKey: KEY }));
  slot.lifecycle.unmount();
  cleanup();

  // While the guide is being written, its own notice says so instead; and Rewrite guide can't run once the folder's gone
  // or the review's archived, so it isn't offered.
  for (const [rpc, shown] of [
    [{ checkFeature: () => nothing }, { ...review, status: "generating" }],
    [{ checkFeature: () => ({ ...nothing, state: "gone", message: "BB removed this folder." }) }, review],
    [{ checkFeature: () => nothing }, { ...review, archivedAt: 5 }],
    [{ checkFeature: () => nothing }, { ...review, userArchivedAt: 5 }],
  ] as const) {
    const quiet = await renderWorkspace(rpc, shown);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Not under +N either.
    const more = quiet.slot.queryByRole("button", { name: /more notices?$/ });
    if (more) fireEvent.click(more);
    expect(quiet.slot.queryByText(text)).toBeNull();
    quiet.slot.lifecycle.unmount();
    cleanup();
  }

  // After Include or Keep out, it says what changed.
  const included = await renderWorkspace({ checkFeature: () => nothing }, { ...local, feature: { ...feature, guideOlderThanDiff: "include" } });
  expect(await included.slot.findByText("The guide was written before you changed which files are shown.")).toBeTruthy();
  included.slot.lifecycle.unmount();
  cleanup();

  // A PR's review its folder updated to the PR's new head says so too.
  const pr = await renderWorkspace({ checkFeature: () => nothing }, { ...review, kind: "pr", repo: "acme/api", number: 7, headSha: "c0ffee", ownPr: true });
  expect(await pr.slot.findByText(text)).toBeTruthy();
  pr.slot.lifecycle.unmount();
});

test("a PR's review whose folder has files not on GitHub yet says how many, with Review them; paused, it offers only a New review", async () => {
  const pr = { ...local, kind: "pr", repo: "acme/api", number: 7, headSha: "c0ffee", ownPr: true };
  const { slot } = await renderWorkspace({ checkFeature: () => ({ ...nothing, state: "ahead", aheadFiles: 3 }) }, pr);
  const text = "3 files in the folder aren’t on GitHub yet.";
  await slot.findByText(text);
  expect(notice(slot, text).querySelector("svg")?.getAttribute("data-icon")).toBe("FileDiff");
  expect(within(notice(slot, text)).getByRole("button", { name: "Review them" })).toBeTruthy();
  slot.lifecycle.unmount();
  cleanup();
  const paused = await renderWorkspace({ checkFeature: () => ({ ...nothing, state: "paused", branch: "bb/fix-docs-thr_cd34" }) }, pr);
  const shown = await paused.slot.findByRole("status", { name: "Review paused" });
  expect(within(shown).getByRole("button", { name: "New review for fix-docs" })).toBeTruthy();
  expect(within(shown).queryByRole("button", { name: "Follow fix-docs" })).toBeNull();
  paused.slot.lifecycle.unmount();
});

test("while the page shows a local review, its branch's PR is looked for every 30 seconds; not on a PR's review, nor while hidden", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const checkPr = vi.fn(() => ({ ok: true }));
    const { slot } = await renderWorkspace({ checkFeature: () => nothing, checkPr });
    expect(checkPr).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(checkPr).toHaveBeenCalledWith({ targetKey: KEY });
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.advanceTimersByTime(30_000);
    expect(checkPr).toHaveBeenCalledTimes(1);
    hidden.mockRestore();
    slot.lifecycle.unmount();
    cleanup();

    const onPr = vi.fn(() => ({ ok: true }));
    const pr = await renderWorkspace({ checkFeature: () => nothing, checkPr: onPr }, { ...local, kind: "pr", repo: "acme/api", number: 7 });
    vi.advanceTimersByTime(60_000);
    expect(onPr).not.toHaveBeenCalled();
    pr.slot.lifecycle.unmount();
  } finally {
    vi.useRealTimers();
  }
});
