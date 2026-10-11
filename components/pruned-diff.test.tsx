// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] }] };
const diffError = "Couldn't read this review's diff from GitHub: error connecting to api.github.com. The guide, your draft and notes are here; try again when GitHub can be reached.";

test("a review whose diff couldn't be read again opens with its guide and says why, until a load reads it", async () => {
  const app = await loadPluginApp(() => import("../app"));
  let offline = true;
  const rpc = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: vi.fn(() => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide, patch: "", revision: "r1", ...(offline ? { diffError } : {}) })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: rpc as any });
  await slot.findByRole("heading", { name: "Parse rows" });
  expect((await slot.findByText(diffError)).closest("[role=alert]")).toBeTruthy();
  offline = false;
  fireEvent.click(slot.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(rpc.getReviewBundle).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(slot.queryByText(diffError)).toBeNull());
  slot.lifecycle.unmount();
});
