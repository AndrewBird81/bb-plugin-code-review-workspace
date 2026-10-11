// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { interdiff } from "../src/interdiff";

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

async function renderWorkspace(review: Record<string, unknown>) {
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Cache rows", headSha: "c3ccccc", ...review }, guide, patch: head, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getPrCommits: vi.fn(() => ({ commits })),
    getSinceReview: vi.fn(({ from }: { from?: string }) => {
      const sha = from ?? "c1aaaaa";
      return { baseline: { sha, at: from ? null : 1, verdict: from ? null : "COMMENT" }, files: interdiff(diffs[sha], head) };
    }),
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("heading", { name: "Cache rows" });
  await slot.findByText("b2");
  return { slot, rpc: handlers };
}

test("the diff compares from a commit you pick, newest first, with your review marked, and says what it compares", async () => {
  const { slot, rpc } = await renderWorkspace({ signals: { lastReviewSha: "c1aaaaa" }, submittedVerdict: "COMMENT" });
  await slot.findByRole("button", { name: "Since your review" });
  fireEvent.click(slot.getByRole("button", { name: "Compare from a commit" }));
  const list = within(await slot.findByRole("list", { name: "Commits" }));
  await list.findByText("Invalidate on write");
  const items = list.getAllByRole("listitem");
  // Your last review, then the commits before the diff shown, newest first.
  expect(items.map((item) => item.textContent)).toEqual([
    "Your last review c1aaaaa",
    "Invalidate on writec2bbbbb2d ago",
    "Add cachec1aaaaa3d agoYour review",
  ]);
  expect(items[0].getAttribute("aria-current")).toBe("true");
  expect(rpc.getPrCommits).toHaveBeenCalledWith({ targetKey: "pr-42" });
  fireEvent.click(items[1]);
  const toggle = await slot.findByRole("button", { name: "Since c2bbbbb, 1 commit ago" });
  expect(rpc.getSinceReview).toHaveBeenLastCalledWith({ targetKey: "pr-42", from: "c2bbbbb" });
  // Picking narrows the diff to what changed since.
  await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
  expect(slot.container.querySelector('[data-file="src/b.ts"]')).toBeNull();
  expect(slot.getByText("1 file unchanged since c2bbbbb")).toBeTruthy();
  expect(within(slot.container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!).getByText("Changed since c2bbbbb")).toBeTruthy();
  // Back to your last review.
  fireEvent.click(slot.getByRole("button", { name: "Compare from a commit" }));
  fireEvent.click(within(await slot.findByRole("list", { name: "Commits" })).getByText("Your last review"));
  await slot.findByRole("button", { name: "Since your review" });
  expect(rpc.getSinceReview).toHaveBeenLastCalledWith({ targetKey: "pr-42" });
  slot.lifecycle.unmount();
}, 15_000);

test("a PR you haven't reviewed can be compared from one of its commits, from the keyboard", async () => {
  const { slot, rpc } = await renderWorkspace({});
  expect(slot.queryByRole("button", { name: "Since your review" })).toBeNull();
  const trigger = slot.getByRole("button", { name: "Compare from a commit" });
  expect(trigger.textContent).toContain("Compare");
  trigger.focus();
  fireEvent.click(trigger);
  const list = within(await slot.findByRole("list", { name: "Commits" }));
  await list.findByText("Add cache");
  const [newer, older] = list.getAllByRole("listitem");
  newer.focus();
  fireEvent.keyDown(newer, { key: "ArrowDown" });
  expect(document.activeElement).toBe(older);
  fireEvent.keyDown(older, { key: "ArrowUp" });
  expect(document.activeElement).toBe(newer);
  fireEvent.keyDown(newer, { key: "ArrowDown" });
  fireEvent.click(document.activeElement!);
  await slot.findByRole("button", { name: "Since c1aaaaa, 2 commits ago" });
  expect(rpc.getSinceReview).toHaveBeenCalledWith({ targetKey: "pr-42", from: "c1aaaaa" });
  slot.lifecycle.unmount();
}, 15_000);

test("a local review has no commits to pick", async () => {
  const { slot } = await renderWorkspace({ kind: "ref", gitRef: "main..HEAD" });
  expect(slot.queryByRole("button", { name: "Compare from a commit" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);
