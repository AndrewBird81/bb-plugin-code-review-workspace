// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { defaultKnobs, type Knobs } from "../lib/knobs";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre>{fileDiff.additionLines.join("\n")}</pre> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const patch = file("src/a.ts", "@@ -1 +1 @@\n-a\n+aa\n") + file("src/b.ts", "@@ -1,2 +1,2 @@\n x\n-b\n+bb\n");
const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[],
  sections: [
    { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] },
    { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/b.ts", summary: "Caches a row." }] },
  ],
  requirements: [
    { text: "Cache parsed rows", status: "covered", evidence: "The cache keeps each row.", file: "src/b.ts", line: 2 },
    { text: "Expire the cache hourly", status: "missing", evidence: "Nothing expires it." },
  ],
};

function renderWorkspace(sent: object, knobs: Knobs = defaultKnobs) {
  return loadPluginApp(() => import("../app")).then((app) => renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(sent), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs }, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  } as any }));
}

test("the Overview tallies the PR's requirements and lists them, each with its status in words, a covered one opening its line", async () => {
  const slot = await renderWorkspace(guide);
  const section = within(await slot.findByRole("region", { name: /^Requirements\s·\s1 of 2 covered$/ }));
  const list = within(section.getByRole("list", { name: "Requirements" }));
  expect(list.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    expect.stringMatching(/Covered.*Cache parsed rows.*The cache keeps each row\..*b\.ts:2/),
    expect.stringMatching(/Missing.*Expire the cache hourly.*Nothing expires it\./),
  ]);
  expect(list.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(list.getByRole("button", { name: "src/b.ts:2" }));
  const chapters = within(slot.getByRole("navigation", { name: "Chapters" }));
  await waitFor(() => expect(chapters.getAllByRole("button").find((b) => b.getAttribute("aria-current") === "step")?.textContent).toContain("Caching"));
  slot.lifecycle.unmount();
}, 15_000);

test("a guide without requirements shows no tally", async () => {
  const { requirements: _, ...old } = guide;
  const slot = await renderWorkspace(old);
  await slot.findByRole("heading", { name: "Parse rows" });
  expect(slot.queryByRole("region", { name: /Requirements/ })).toBeNull();
  expect(slot.queryByRole("list", { name: "Requirements" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("with Requirements off in Settings, the Overview shows no Requirements section", async () => {
  const slot = await renderWorkspace(guide, { ...defaultKnobs, requirements: false });
  await slot.findByRole("heading", { name: "Parse rows" });
  await waitFor(() => expect(slot.queryByRole("region", { name: /Requirements/ })).toBeNull());
  expect(slot.queryByRole("list", { name: "Requirements" })).toBeNull();
  expect(slot.queryByText(/covered/)).toBeNull();
  expect(slot.getByText("Parses rows.")).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);
