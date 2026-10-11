// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { WorkspaceProvider, useWorkspace, type WorkspaceApi } from "./workspace-context";
import { panelPage, publishWorkspace, useWorkspaceFor } from "./workspace-store";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

const fake = (targetKey: string) => ({ targetKey }) as WorkspaceApi;

test("a subPath shows the list, Review settings, or a review, as the panel routes it", () => {
  expect(panelPage("")).toEqual({ kind: "list" });
  expect(panelPage("settings")).toEqual({ kind: "settings", returnTo: "" });
  expect(panelPage("settings/pr-86f279ce9c29f106-42")).toEqual({ kind: "settings", returnTo: "pr-86f279ce9c29f106-42" });
  expect(panelPage("pr-86f279ce9c29f106-42")).toEqual({ kind: "review", targetKey: "pr-86f279ce9c29f106-42" });
  expect(panelPage("ref-1a2b/extra")).toEqual({ kind: "review", targetKey: "ref-1a2b" });
});

test("each review's workspace is found by its key alone, and a withdrawn one doesn't take its successor along", () => {
  const { result, rerender } = renderHook(({ targetKey }) => useWorkspaceFor(targetKey), { initialProps: { targetKey: "a" as string | null } });
  expect(result.current).toBeNull();
  const a = fake("a"), b = fake("b");
  let withdrawA!: () => void;
  act(() => { withdrawA = publishWorkspace(a); publishWorkspace(b); });
  expect(result.current).toBe(a);
  rerender({ targetKey: "b" });
  expect(result.current).toBe(b);
  rerender({ targetKey: null });
  expect(result.current).toBeNull();
  // The same review mounted again: the old workspace's cleanup comes after the new one published.
  rerender({ targetKey: "a" });
  const again = fake("a");
  act(() => { publishWorkspace(again); withdrawA(); });
  expect(result.current).toBe(again);
});

test("the provider gives its views the api, publishes it while mounted, and useWorkspace refuses outside one", () => {
  const api = fake("provided");
  const seen: WorkspaceApi[] = [];
  function View() { seen.push(useWorkspace()); return null; }
  const store = renderHook(() => useWorkspaceFor("provided"));
  const page = render(createElement(WorkspaceProvider, { api, children: createElement(View) }));
  expect(seen.at(-1)).toBe(api);
  expect(store.result.current).toBe(api);
  page.unmount();
  expect(store.result.current).toBeNull();
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => renderHook(() => useWorkspace())).toThrow("only for views inside a review's workspace");
});

test("an open review publishes its workspace: it shows what the page shows, its commands change the page, and leaving withdraws it", async () => {
  const patch = ["src/a.ts", "src/b.ts"].map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+aa\n`).join("");
  const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [], sections: [
    { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] },
    { id: "c2", title: "Writing", overview: "Writes rows.", diffs: [{ file: "src/b.ts", summary: "Writes a row." }] },
  ] };
  const setFilesViewed = vi.fn(() => ({ ok: true }));
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    setFilesViewed,
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  } as any });
  const store = renderHook(() => useWorkspaceFor("pr-42"));
  await waitFor(() => expect(store.result.current).not.toBeNull());
  const api = () => store.result.current!;
  expect(api()).toMatchObject({ targetKey: "pr-42", activeId: "c1", review: { title: "Parse rows" }, guide: { title: "Guide" }, nav: { open: true, view: "chapters" } });
  expect(api().sections.map((section) => section.id)).toEqual(["c1", "c2"]);
  act(() => api().go("c2"));
  expect(api().activeId).toBe("c2");
  await slot.findByText("Chapter 2 of 2");
  act(() => api().files.markChapterViewed("c2"));
  expect(setFilesViewed).toHaveBeenCalledWith(expect.objectContaining({ targetKey: "pr-42", files: ["src/b.ts"] }));
  await waitFor(() => expect(api().files.views.get("src/b.ts")?.viewed).toBe(true));
  act(() => api().nav.toggle());
  expect(api().nav.open).toBe(false);
  expect(slot.queryByRole("button", { name: "Show chapters" })).not.toBeNull();
  slot.lifecycle.unmount();
  expect(store.result.current).toBeNull();
});
