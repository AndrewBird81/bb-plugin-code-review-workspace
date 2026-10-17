// @vitest-environment jsdom
// The GitHub account menu: whose account reviews go out as, and what switching it changes.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre>{fileDiff.additionLines.join("\n")}</pre> }));
Element.prototype.scrollIntoView ??= () => {};
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); });

const SERVER_WIDE = "Switching changes gh for everything on this BB server, other agents and terminals included.";

async function openMenu(accounts: { login: string; active: boolean }[]) {
  await loadPluginApp(() => import("../app"));
  const { AccountBar } = await import("./AccountBar");
  const slot = renderSlot({ component: AccountBar }, {}, { rpc: { getGhAccounts: () => ({ active: "me", accounts }) } as any });
  fireEvent.click(await slot.findByRole("button", { name: "GitHub account: @me" }));
  await slot.findByText("Signed in as @me");
  return slot;
}

test("with another account to switch to, the menu says switching changes gh for the whole server", async () => {
  const slot = await openMenu([{ login: "me", active: true }, { login: "work", active: false }]);
  const line = slot.getByText(SERVER_WIDE);
  // Above the accounts it's about.
  expect(line.compareDocumentPosition(slot.getByRole("button", { name: "Use @work on this BB server" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  slot.lifecycle.unmount();
});

test("with only one account there's nothing to switch, and nothing about switching", async () => {
  const slot = await openMenu([{ login: "me", active: true }]);
  expect(slot.queryByText(SERVER_WIDE)).toBeNull();
  slot.lifecycle.unmount();
});

type Access = { accessible: boolean; repo: string | null; account: string | null; badCredentials?: boolean; error?: string };
/** The review, its repo access checked with `access` each time. */
async function renderReview(access: () => Access) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const rpc = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({
      review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", repo: "acme/web", number: 42 },
      guide: { title: "Guide", intent: "x", unplacedFiles: [], sections: [{ id: "c1", title: "Parsing", overview: "o", diffs: [{ file: "src/a.ts", summary: "s" }] }] },
      patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n", revision: "r1",
    }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: vi.fn(access),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: rpc as any });
  await slot.findByText("aa");
  await waitFor(() => expect(rpc.checkRepoAccess).toHaveBeenCalled());
  const reconnect = async () => {
    await slot.setRealtimeConnectionState("disconnected" as any);
    await slot.setRealtimeConnectionState("connected");
  };
  return { slot, rpc, reconnect };
}

// bug bash PRF-2: with GitHub unreachable the review said your account couldn't access the repo, and kept saying so:
// access was checked again only when the guide or the account changed, not on the reconnect's reload.
test("the no-access notice goes once GitHub answers again after a reconnect", async () => {
  let online = false;
  const { slot, rpc, reconnect } = await renderReview(() => online ? { accessible: true, repo: "acme/web", account: "me" } : { accessible: false, repo: "acme/web", account: null });
  expect(await slot.findByText(/Your GitHub account can’t access acme\/web/)).toBeTruthy();
  online = true;
  await reconnect();
  await waitFor(() => expect(rpc.checkRepoAccess).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(slot.queryByText(/can’t access acme\/web/)).toBeNull());
  slot.lifecycle.unmount();
}, 15_000);

test("access GitHub couldn't be checked for shows no notice, and is checked again on the reconnect", async () => {
  let online = false;
  const { slot, rpc, reconnect } = await renderReview(() => online ? { accessible: true, repo: "acme/web", account: "me" } : { accessible: true, repo: "acme/web", account: null, error: "error connecting to api.github.com" });
  await new Promise((done) => setTimeout(done, 20));
  expect(slot.queryByText(/can’t access/)).toBeNull();
  online = true;
  await reconnect();
  await waitFor(() => expect(rpc.checkRepoAccess).toHaveBeenCalledTimes(2));
  // Answered, it isn't checked again on the next reload.
  await reconnect();
  await new Promise((done) => setTimeout(done, 20));
  expect(rpc.checkRepoAccess).toHaveBeenCalledTimes(2);
  slot.lifecycle.unmount();
}, 15_000);

test("credentials GitHub refuses say so, with the account switcher", async () => {
  const { slot } = await renderReview(() => ({ accessible: false, repo: "acme/web", account: null, badCredentials: true }));
  expect(await slot.findByText("GitHub refused your account’s credentials. Switch account:")).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);
