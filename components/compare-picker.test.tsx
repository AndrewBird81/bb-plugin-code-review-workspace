// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { interdiff } from "../src/interdiff";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre>{fileDiff.additionLines.join("")}</pre> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const at = (a: string, b: string) => file("src/a.ts", `@@ -1 +1 @@\n-x\n+${a}\n`) + file("src/b.ts", `@@ -1 +1 @@\n-y\n+${b}\n`);
const head = at("a3", "b2");
const diffs: Record<string, string> = { c1aaaaa: at("a1", "b1"), c2bbbbb: at("a2", "b2") };
const guide = { title: "Guide", intent: "Rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Rows", overview: "", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }] }] };
const DAY = 86_400_000;
const commits = [
  { sha: "c3ccccc", headline: "Rename key", committedAt: Date.now() - DAY },
  { sha: "c2bbbbb", headline: "Invalidate on write", committedAt: Date.now() - 2 * DAY },
  { sha: "c1aaaaa", headline: "Add cache", committedAt: Date.now() - 3 * DAY },
];

async function renderWorkspace(review: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  // Opened before, on its chapter: a first open shows the Overview.
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  // What a new push and rebuild change.
  const pr = { headSha: "c3ccccc", commits, revision: "r1" };
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Cache rows", headSha: pr.headSha, ...review }, guide, patch: head, revision: pr.revision }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getPrCommits: vi.fn(() => ({ commits: pr.commits })),
    getSinceReview: vi.fn(({ from }: { from?: string }) => {
      const sha = from ?? "c1aaaaa";
      return { baseline: { sha, at: from ? null : 1, verdict: from ? null : "COMMENT" }, files: interdiff(diffs[sha], head) };
    }),
    ...overrides,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByText("b2");
  /** A new commit is pushed, and the review rebuilt on it. */
  const push = async () => {
    Object.assign(pr, { headSha: "c4ddddd", commits: [{ sha: "c4ddddd", headline: "Log misses", committedAt: Date.now() }, ...commits], revision: "r2" });
    await slot.emitRealtime("review:pr-42", {});
  };
  return { slot, rpc: handlers, push };
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];

/** The band's compare select's menu. */
async function bandMenu(slot: Slot, label: RegExp | string = /^Show changes: /) {
  fireEvent.click(await slot.findByRole("button", { name: label }));
  return within(await slot.findByRole("menu", { name: "Show changes" }));
}
/** Diff options' page of commits to compare from, where the band has no compare select. */
async function commitsInOptions(slot: Slot) {
  fireEvent.click(slot.getByRole("button", { name: "Diff options" }));
  fireEvent.click(await slot.findByRole("button", { name: "Compare with a commit…" }));
  return within(await slot.findByRole("menu", { name: "Show changes" }));
}
const choices = (menu: ReturnType<typeof within>) => menu.getAllByRole("menuitemradio") as HTMLElement[];

test("the compare select's label says what the diff shows; its menu lists your review once, then the earlier commits, newest first", async () => {
  const { slot, rpc } = await renderWorkspace({ signals: { lastReviewSha: "c1aaaaa" }, submittedVerdict: "COMMENT" });
  // A re-review opens on what changed since your review.
  let menu = await bandMenu(slot, "Show changes: Since your review");
  await menu.findByText("Invalidate on write");
  // All of the PR, then your last review, then the commits before the diff shown: the head and your review's aren't again.
  expect(choices(menu).map((item) => item.textContent)).toEqual(["All changes in this PR", "Since your reviewc1aaaaa", "Invalidate on writec2bbbbb · 2d ago"]);
  expect(choices(menu).map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  expect(rpc.getPrCommits).toHaveBeenCalledWith({ targetKey: "pr-42" });
  fireEvent.click(menu.getByRole("menuitemradio", { name: /^Invalidate on write/ }));
  await slot.findByRole("button", { name: "Show changes: Since c2bbbbb, 1 commit ago" });
  expect(rpc.getSinceReview).toHaveBeenLastCalledWith({ targetKey: "pr-42", from: "c2bbbbb" });
  // Picking narrows the diff to what changed since.
  await waitFor(() => expect(slot.container.querySelector('[data-file="src/b.ts"]')).toBeNull());
  expect(slot.getByText("1 file unchanged since c2bbbbb")).toBeTruthy();
  expect(within(slot.container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!).getByTitle("Changed since c2bbbbb").textContent).toBe("Changed since c2bbbbb");
  // Back to your last review.
  menu = await bandMenu(slot);
  expect(menu.getByRole("menuitemradio", { name: /^Invalidate on write/ }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(menu.getByRole("menuitemradio", { name: /^Since your review/ }));
  await slot.findByRole("button", { name: "Show changes: Since your review" });
  expect(rpc.getSinceReview).toHaveBeenLastCalledWith({ targetKey: "pr-42" });
  // And all of it.
  fireEvent.click((await bandMenu(slot)).getByRole("menuitemradio", { name: "All changes in this PR" }));
  await slot.findByRole("button", { name: "Show changes: All changes" });
  expect(slot.container.querySelector('[data-file="src/b.ts"]')).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("Since your review, picked while its comparison loads, narrows the diff once it arrives", async () => {
  let answer!: () => void;
  const { slot } = await renderWorkspace({ signals: { lastReviewSha: "c1aaaaa" }, submittedVerdict: "COMMENT" }, {
    getSinceReview: () => new Promise((resolve) => { answer = () => resolve({ baseline: { sha: "c1aaaaa", at: 1, verdict: "COMMENT" }, files: interdiff(diffs.c1aaaaa, head) }); }),
  });
  fireEvent.click((await bandMenu(slot)).getByRole("menuitemradio", { name: /^Since your review/ }));
  answer();
  expect(await slot.findByRole("button", { name: "Show changes: Since your review" })).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("a PR you haven't reviewed has no compare select until you compare it with one of its commits, from Diff options and the keyboard", async () => {
  const { slot, rpc } = await renderWorkspace({});
  expect(slot.queryByRole("button", { name: /^Show changes/ })).toBeNull();
  const menu = await commitsInOptions(slot);
  await menu.findByText("Add cache");
  const [all, newer, older] = choices(menu);
  expect(all.textContent).toBe("All changes in this PR");
  newer.focus();
  fireEvent.keyDown(newer, { key: "ArrowDown" });
  expect(document.activeElement).toBe(older);
  fireEvent.keyDown(older, { key: "ArrowUp" });
  expect(document.activeElement).toBe(newer);
  fireEvent.keyDown(newer, { key: "ArrowDown" });
  fireEvent.click(document.activeElement!);
  // The band shows what the diff shows now.
  await slot.findByRole("button", { name: "Show changes: Since c1aaaaa, 2 commits ago" });
  expect(rpc.getSinceReview).toHaveBeenCalledWith({ targetKey: "pr-42", from: "c1aaaaa" });
  expect(slot.queryByRole("menu")).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("a local review has no commits to pick", async () => {
  const { slot } = await renderWorkspace({ kind: "ref", gitRef: "main..HEAD" });
  fireEvent.click(slot.getByRole("button", { name: "Diff options" }));
  await slot.findByRole("switch", { name: "Wrap long lines" });
  expect(slot.queryByRole("button", { name: "Compare with a commit…" })).toBeNull();
  expect(slot.queryByRole("button", { name: /^Show changes/ })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("after a new push and rebuild, the commit list and how many commits ago are read again", async () => {
  const { slot, rpc, push } = await renderWorkspace({ signals: { lastReviewSha: "c1aaaaa" }, submittedVerdict: "COMMENT" });
  fireEvent.click(await (await bandMenu(slot)).findByText("Invalidate on write"));
  await slot.findByRole("button", { name: "Show changes: Since c2bbbbb, 1 commit ago" });
  // A new diff shows what changed since your review again, as Settings has it.
  await push();
  await slot.findByRole("button", { name: "Show changes: Since your review" });
  // Read again as the menu opens, with the new commit.
  const menu = await bandMenu(slot);
  expect(await menu.findByText("Rename key")).toBeTruthy();
  expect(rpc.getPrCommits).toHaveBeenCalledTimes(2);
  fireEvent.click(menu.getByText("Invalidate on write"));
  expect(await slot.findByRole("button", { name: "Show changes: Since c2bbbbb, 2 commits ago" })).toBeTruthy();
  expect(rpc.getPrCommits).toHaveBeenCalledTimes(2);
  slot.lifecycle.unmount();
}, 15_000);

test("with your last review at the head there's nothing to compare it with, so it isn't offered, and with Settings on All changes nothing narrows later", async () => {
  const { slot, push } = await renderWorkspace({ signals: { lastReviewSha: "c3ccccc" }, submittedVerdict: "COMMENT" }, { getPreferences: () => ({ preferences: { ...defaultPreferences, rereviewShows: "all" }, revision: 0 }) });
  expect(slot.queryByRole("button", { name: /^Show changes/ })).toBeNull();
  const menu = await commitsInOptions(slot);
  await menu.findByText("Add cache");
  expect(menu.queryByRole("menuitemradio", { name: /^Since your review/ })).toBeNull();
  fireEvent.click(menu.getByText("Invalidate on write"));
  await slot.findByRole("button", { name: "Show changes: Since c2bbbbb, 1 commit ago" });
  // All changes lets the commit go, with nothing of yours to compare with instead.
  fireEvent.click((await bandMenu(slot)).getByRole("menuitemradio", { name: "All changes in this PR" }));
  await waitFor(() => expect(slot.queryByRole("button", { name: /^Show changes/ })).toBeNull());
  // A later push gives your review something to compare with; the diff isn't narrowed to it unasked.
  await push();
  expect(await slot.findByRole("button", { name: "Show changes: All changes" })).toBeTruthy();
  expect(slot.container.querySelector('[data-file="src/b.ts"]')).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("on a re-review, All changes lets a picked commit go: the files' badges say what changed since your review again", async () => {
  const { slot, rpc } = await renderWorkspace({ signals: { lastReviewSha: "c1aaaaa" }, submittedVerdict: "COMMENT" });
  fireEvent.click(await (await bandMenu(slot)).findByText("Invalidate on write"));
  await slot.findByRole("button", { name: "Show changes: Since c2bbbbb, 1 commit ago" });
  await waitFor(() => expect(slot.queryAllByTitle("Changed since c2bbbbb")).not.toEqual([]));
  fireEvent.click((await bandMenu(slot)).getByRole("menuitemradio", { name: "All changes in this PR" }));
  await waitFor(() => expect(slot.queryAllByTitle("Changed since your review")).toHaveLength(2));
  expect(rpc.getSinceReview).toHaveBeenLastCalledWith({ targetKey: "pr-42" });
  // Your review's comparison, arriving, doesn't narrow the diff.
  expect(slot.getByRole("button", { name: "Show changes: All changes" })).toBeTruthy();
  expect(slot.queryAllByTitle("Changed since c2bbbbb")).toEqual([]);
  slot.lifecycle.unmount();
}, 15_000);

test("a new push lets a picked commit go, as All changes does, so the select and the badges agree", async () => {
  const { slot, rpc, push } = await renderWorkspace({ signals: { lastReviewSha: "c1aaaaa" }, submittedVerdict: "COMMENT" });
  fireEvent.click(await (await bandMenu(slot)).findByText("Invalidate on write"));
  await slot.findByRole("button", { name: "Show changes: Since c2bbbbb, 1 commit ago" });
  await waitFor(() => expect(slot.queryAllByTitle("Changed since c2bbbbb")).not.toEqual([]));
  await push();
  await slot.findByRole("button", { name: "Show changes: Since your review" });
  // The badges count from your review again, not from the commit the select no longer names.
  await waitFor(() => expect(slot.queryAllByTitle("Changed since your review")).toHaveLength(2));
  expect(slot.queryAllByTitle("Changed since c2bbbbb")).toEqual([]);
  expect(rpc.getSinceReview).toHaveBeenLastCalledWith({ targetKey: "pr-42" });
  slot.lifecycle.unmount();
}, 15_000);

test("opening a file the narrowing hides, or a line from Find, lets a picked commit go as All changes does, so the select and the badges agree", async () => {
  const { slot } = await renderWorkspace({ signals: { lastReviewSha: "c1aaaaa" }, submittedVerdict: "COMMENT" });
  const pick = async () => {
    fireEvent.click(await (await bandMenu(slot)).findByText("Invalidate on write"));
    await slot.findByRole("button", { name: "Show changes: Since c2bbbbb, 1 commit ago" });
    // b.ts hasn't changed since c2bbbbb.
    await waitFor(() => expect(slot.container.querySelector('[data-file="src/b.ts"]')).toBeNull());
  };
  const letGo = async () => {
    await waitFor(() => expect(slot.queryAllByTitle("Changed since your review")).toHaveLength(2));
    expect(slot.getByRole("button", { name: "Show changes: All changes" })).toBeTruthy();
    expect(slot.queryAllByTitle("Changed since c2bbbbb")).toEqual([]);
    expect(slot.container.querySelector('[data-file="src/b.ts"]')).toBeTruthy();
  };
  await pick();
  fireEvent.click(within(slot.getByRole("navigation", { name: "Chapters" })).getByText("b.ts"));
  await letGo();
  await pick();
  fireEvent.change(slot.getByRole("searchbox", { name: "Find in review" }), { target: { value: "b2" } });
  const results = within(await slot.findByRole("list", { name: "Results" }));
  fireEvent.click(results.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "src/b.ts:1").closest("button")!);
  await letGo();
  slot.lifecycle.unmount();
}, 15_000);

test("a comparison that fails says why in the compare menu, not only in the select's tooltip", async () => {
  const { slot } = await renderWorkspace({ signals: { lastReviewSha: "c1aaaaa" }, submittedVerdict: "COMMENT" }, {
    getSinceReview: () => ({ baseline: null, files: [], error: "gh: not found" }),
  });
  const menu = await bandMenu(slot, "Show changes: All changes. Couldn’t compare with your last review: gh: not found");
  await menu.findByText("Invalidate on write");
  expect(menu.getByRole("status").textContent).toBe("Couldn’t compare with your last review: gh: not found");
  slot.lifecycle.unmount();
}, 15_000);

test("on a PR you haven't reviewed, a picked commit can be cleared", async () => {
  const { slot, rpc } = await renderWorkspace({});
  fireEvent.click(await (await commitsInOptions(slot)).findByText("Add cache"));
  await slot.findByRole("button", { name: "Show changes: Since c1aaaaa, 2 commits ago" });
  await waitFor(() => expect(slot.queryAllByTitle("Changed since c1aaaaa")).not.toEqual([]));
  fireEvent.click((await bandMenu(slot)).getByRole("menuitemradio", { name: "All changes in this PR" }));
  await waitFor(() => expect(slot.queryAllByTitle("Changed since c1aaaaa")).toEqual([]));
  expect(slot.queryByRole("button", { name: /^Show changes/ })).toBeNull();
  expect(rpc.getSinceReview).toHaveBeenCalledTimes(1);
  slot.lifecycle.unmount();
}, 15_000);
