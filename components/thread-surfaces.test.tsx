// @vitest-environment jsdom
// BB's thread pages: Review changes above a thread's message box, shown only for a folder with changes or a review
// while Settings has it on, reading BB's git status of the folder and never its diff; and the Review tab, only beside a
// thread linked to a review, with its id and name, its comments and where each stands, the agent's chat and Open review.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginAppDefinition } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import appModule from "../app";
import { defaultPreferences } from "../src/preferences";
import { getReviewState } from "../lib/panel-state";
import { ReviewChangesSegment, ReviewTab, useReviewChangesVisible, useReviewTabVisible } from "./ThreadSurfaces";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, Toaster: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

type Link = { targetKey: string; createdAt: number; main: string | null; threads: string[]; folder: { environmentId: string; branch: string; paused: boolean } | null };
/** The folder's git status as BB's Git plugin answers its keyed `status`: `files` changed, on `branch`. */
const gitStatus = (folders: Record<string, { files: number; branch?: string | null } | "not_applicable">) => ({ keys }: { keys: string[] }) =>
  Object.fromEntries(keys.map((key) => {
    const folder = folders[key];
    if (!folder || folder === "not_applicable") return [key, { outcome: "not_applicable", reason: "non_git_environment", message: "Not a git folder." }];
    return [key, { outcome: "available", workspace: { workingTree: { fileCount: folder.files }, mergeBase: null, branch: { currentBranch: folder.branch === undefined ? "feat/qa" : folder.branch } } }];
  }));

function handlers({ links = [], on = true, folders = {}, agents = [], open = 2, rpc = {} }: { links?: Link[]; on?: boolean; folders?: Parameters<typeof gitStatus>[0]; agents?: string[]; open?: number; rpc?: Record<string, unknown> }) {
  return {
    threadLinks: () => ({ reviewChangesLine: on, reviews: links, agents }),
    status: gitStatus(folders),
    threadReview: ({ targetKey }: { targetKey: string }) => ({ review: { targetKey, kind: "ref", gitRef: "feat/qa", title: "Snooze flaky checks", feature: { environmentId: "env1", branch: "feat/qa" }, place: { repo: "acme/api", machine: "MaxBook", path: "/Users/me/src/api" } }, open }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    ...rpc,
  } as never;
}

/** What a thread's Review changes and its Review tab decide, for a thread in `environment`. */
function Probe({ threadId, environment }: { threadId: string; environment: { id: string } | null }) {
  const segment = useReviewChangesVisible({ threadId, projectId: "p1", environment });
  const tab = useReviewTabVisible({ threadId, environment });
  return <p>{`segment:${segment ? "shown" : "hidden"} tab:${tab ? "shown" : "hidden"}`}</p>;
}
/** The probe, once the index and any git status it asks for have answered. */
async function probe(threadId: string, environment: { id: string } | null, options: Parameters<typeof handlers>[0]) {
  const slot = renderSlot({ component: Probe }, { threadId, environment }, { rpc: handlers(options) });
  await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "threadLinks")).toBe(true));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return slot;
}
const folderReview = (environmentId: string, extra: Partial<Link> = {}): Link => ({ targetKey: `br-${environmentId}`, createdAt: 1, main: "lead", threads: ["lead"], folder: { environmentId, branch: "feat/qa", paused: false }, ...extra });

test("a host without the thread slots loads the plugin as before, with each slot absent in turn", async () => {
  const definition = appModule as unknown as PluginAppDefinition & { setup(app: unknown): void };
  const without = (slot: string) => ({ __bbPluginApp: true, setup: (app: { slots: object }) => definition.setup(new Proxy(app, {
    get: (target, name) => name === "slots" ? new Proxy(target.slots, { get: (slots, member) => member === slot ? undefined : Reflect.get(slots, member) }) : Reflect.get(target, name),
  })) }) as unknown as PluginAppDefinition;
  const all = await loadPluginApp(definition);
  expect(all.threadContextSegments.map((segment) => [segment.id, segment.group, segment.order])).toEqual([["review-changes", "3_git", 20]]);
  expect(all.tabs.map((tab) => [tab.id, tab.context, tab.availability])).toEqual([["review", { kind: "thread" }, "fixed"]]);
  for (const slot of ["experimental_threadContextSegment", "experimental_tab"]) {
    const loaded = await loadPluginApp(without(slot));
    expect(loaded.navPanels.map((panel) => panel.id)).toEqual(["review"]);
    expect(loaded.threadContextSegments).toHaveLength(slot === "experimental_threadContextSegment" ? 0 : 1);
    expect(loaded.tabs).toHaveLength(slot === "experimental_tab" ? 0 : 1);
  }
  const neither = { __bbPluginApp: true, setup: (app: { slots: object }) => definition.setup(new Proxy(app, {
    get: (target, name) => name === "slots" ? new Proxy(target.slots, { get: (slots, member) => member === "experimental_tab" || member === "experimental_threadContextSegment" ? undefined : Reflect.get(slots, member) }) : Reflect.get(target, name),
  })) } as unknown as PluginAppDefinition;
  expect((await loadPluginApp(neither)).navPanels).toHaveLength(1);
});

test("Review changes shows only for a folder with changes or a review, while Settings has it on", async () => {
  // Settings off: hidden, with changes and a review, and git isn't asked. First, as the index is kept between mounts.
  const off = await probe("t-off", { id: "env-off" }, { on: false, folders: { "env-off": { files: 2 } }, links: [folderReview("env-off")] });
  expect(off.getByText(/segment:hidden/)).toBeTruthy();
  expect(off.rpcCalls.filter((call) => call.method === "status")).toEqual([]);
  cleanup();
  // No folder: nothing to review, and git isn't asked.
  const none = await probe("t-none", null, { folders: { "env-a": { files: 3 } } });
  expect(none.getByText(/segment:hidden/)).toBeTruthy();
  expect(none.rpcCalls.filter((call) => call.method === "status")).toEqual([]);
  cleanup();
  // A clean folder with no review.
  expect((await probe("t-clean", { id: "env-clean" }, { folders: { "env-clean": { files: 0 } } })).getByText(/segment:hidden/)).toBeTruthy();
  cleanup();
  // A folder with changes.
  expect((await probe("t-changes", { id: "env-changes" }, { folders: { "env-changes": { files: 2 } } })).getByText(/segment:shown/)).toBeTruthy();
  cleanup();
  // A clean folder with a review at its branch; not one at another branch.
  expect((await probe("t-review", { id: "env-review" }, { folders: { "env-review": { files: 0 } }, links: [folderReview("env-review")] })).getByText(/segment:shown/)).toBeTruthy();
  cleanup();
  expect((await probe("t-review2", { id: "env-review2" }, { folders: { "env-review2": { files: 0, branch: "main" } }, links: [folderReview("env-review2")] })).getByText(/segment:hidden/)).toBeTruthy();
  cleanup();
  // Git can't say (not a git folder, or its plugin off): a review the folder was last seen on its branch for still shows.
  expect((await probe("t-nogit", { id: "env-nogit" }, { folders: { "env-nogit": "not_applicable" }, links: [folderReview("env-nogit")] })).getByText(/segment:shown/)).toBeTruthy();
  cleanup();
  // A review agent's or guide writer's own page, in a checkout with changes and a review: never, nor its tab.
  expect((await probe("t-agent", { id: "env-agent" }, { folders: { "env-agent": { files: 2 } }, links: [folderReview("env-agent")], agents: ["t-agent"] })).getByText("segment:hidden tab:hidden")).toBeTruthy();
});

test("across many threads, Review changes reads BB's git status of each folder and the plugin's index, never a diff", async () => {
  const environments = Array.from({ length: 24 }, (_, at) => `env-many-${at}`);
  const folders = Object.fromEntries(environments.map((id, at) => [id, { files: at % 3 }]));
  const links = environments.filter((_, at) => at % 4 === 0).map((id) => folderReview(id));
  const slot = renderSlot({ component: () => <>{environments.map((id, at) => <div key={id}>
    <Probe threadId={`t-${at}`} environment={{ id }} />
    <ReviewChangesSegment threadId={`t-${at}`} projectId="p1" environment={{ id }} segments={[]} isExpanded={false} onToggle={() => {}} />
  </div>)}</> }, {}, { rpc: handlers({ links, folders }) });
  await waitFor(() => expect(slot.getAllByText(/segment:/)).toHaveLength(24));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const methods = new Set(slot.rpcCalls.map((call) => call.method));
  expect([...methods].sort()).toEqual(["status", "threadLinks", "threadReview"]);
  // One status read per folder at most, batched as BB's keyed read does; one review read per folder review.
  const statusKeys = slot.rpcCalls.filter((call) => call.method === "status").flatMap((call) => (call.input as { keys: string[] }).keys);
  expect(new Set(statusKeys).size).toBe(statusKeys.length);
  expect(slot.rpcCalls.filter((call) => call.method === "threadReview")).toHaveLength(links.length);
  // The index read once at a time: one now, and one more for the reads asked for meanwhile.
  expect(slot.rpcCalls.filter((call) => call.method === "threadLinks").length).toBeLessThanOrEqual(2);
});

test("Review changes starts the folder's review and opens it; with one, it reads Review · 2 open and does the same, opening it as it is", async () => {
  const reviewThreadChanges = vi.fn(() => ({ ok: true, targetKey: "br-new" }));
  const props = { threadId: "t-start", projectId: "p1", environment: { id: "env-start" }, segments: [], isExpanded: false, onToggle: () => {} };
  const start = renderSlot({ component: ReviewChangesSegment }, props, { rpc: handlers({ folders: { "env-start": { files: 2 } }, rpc: { reviewThreadChanges } }) });
  const button = await start.findByRole("button", { name: "Review changes" });
  expect([button.textContent, button.title]).toEqual(["Review changes", "Review this folder’s changes"]);
  fireEvent.click(button);
  await waitFor(() => expect(start.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "br-new" } }]));
  expect(reviewThreadChanges).toHaveBeenCalledWith({ threadId: "t-start" });
  cleanup();

  const failing = renderSlot({ component: ReviewChangesSegment }, { ...props, threadId: "t-fail", environment: { id: "env-fail" } }, { rpc: handlers({ folders: { "env-fail": { files: 2 } }, rpc: { reviewThreadChanges: () => ({ ok: false, error: "This thread’s folder isn’t ready yet. Try again once it is." }) } }) });
  fireEvent.click(await failing.findByRole("button", { name: "Review changes" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This thread’s folder isn’t ready yet. Try again once it is."));
  expect(failing.navigateCalls).toEqual([]);
  cleanup();

  // With a review, it asks the server too, as bb review does there: a live thread takes over from an archived main thread.
  const opening = vi.fn(() => ({ ok: true, targetKey: "br-env-open" }));
  const existing = renderSlot({ component: ReviewChangesSegment }, { ...props, threadId: "t-open", environment: { id: "env-open" } }, { rpc: handlers({ folders: { "env-open": { files: 0 } }, links: [folderReview("env-open")], rpc: { reviewThreadChanges: opening } }) });
  const open = await existing.findByRole("button", { name: "Review, 2 comments open" });
  expect([open.textContent, open.title]).toEqual(["Review · 2 open", "Open this folder’s review"]);
  fireEvent.click(open);
  await waitFor(() => expect(existing.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "br-env-open" } }]));
  expect(opening).toHaveBeenCalledWith({ threadId: "t-open" });
  cleanup();

  // Nothing open reads "Review"; and when the server can't open it as bb review would, as with its machine offline, it
  // still opens as it is.
  const offline = renderSlot({ component: ReviewChangesSegment }, { ...props, threadId: "t-off", environment: { id: "env-offline" } }, { rpc: handlers({ open: 0, folders: { "env-offline": { files: 0 } }, links: [folderReview("env-offline")], rpc: { reviewThreadChanges: () => ({ ok: false, error: "This thread’s folder isn’t ready yet." }) } }) });
  const plain = await offline.findByRole("button", { name: "Review, no comments open" });
  expect(plain.textContent).toBe("Review");
  fireEvent.click(plain);
  await waitFor(() => expect(offline.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "br-env-offline" } }]));
  expect(toast.error).toHaveBeenCalledTimes(1);
});

test("the Review tab shows only beside a thread linked to a review: its main thread, a fixer it sent to, a thread in its folder", async () => {
  const links: Link[] = [
    { targetKey: "br-tab", createdAt: 2, main: "lead", threads: ["lead", "fixer"], folder: { environmentId: "env-tab", branch: "feat/qa", paused: false } },
    { targetKey: "pr-tab", createdAt: 1, main: "pr-fixer", threads: ["pr-fixer"], folder: null },
    { targetKey: "br-paused", createdAt: 3, main: "other-lead", threads: ["other-lead"], folder: { environmentId: "env-paused", branch: "feat/old", paused: true } },
  ];
  const cases: Array<[string, { id: string } | null, "shown" | "hidden"]> = [
    ["lead", { id: "env-tab" }, "shown"], ["fixer", { id: "env-fixer" }, "shown"], ["pr-fixer", null, "shown"], ["sub", { id: "env-tab" }, "shown"],
    ["stranger", { id: "env-elsewhere" }, "hidden"], ["loner", null, "hidden"], ["visitor", { id: "env-paused" }, "hidden"],
  ];
  for (const [threadId, environment, shown] of cases) {
    const slot = await probe(threadId, environment, { links });
    expect(slot.getByText(new RegExp(`tab:${shown}`)), threadId).toBeTruthy();
    cleanup();
  }
});

const draft = {
  draft: { targetKey: "br-tab", verdict: "COMMENT", body: "", comments: [
    { file: "src/a.ts", line: 1, side: "RIGHT", body: "Wait a day.", id: "c1", state: "open" },
    { file: "src/a.ts", line: 4, side: "RIGHT", body: "Log the snooze.", id: "c2", state: "sent", sendN: 1, claim: { outcome: "done", note: "Logged it.", at: 5, threadId: "lead" } },
    { file: "src/b.ts", line: 2, side: "RIGHT", body: "Old check.", id: "c3", state: "resolved" },
  ] },
  stale: [],
};
const tabLinks: Link[] = [{ targetKey: "br-tab", createdAt: 2, main: "lead", threads: ["lead"], folder: { environmentId: "env-tab", branch: "feat/qa", paused: false } }];

test("the Review tab names the review, lists its comments with where each stands, shows the review agent's chat, and opens the review", async () => {
  const slot = renderSlot({ component: ReviewTab }, { threadId: "lead", environment: { id: "env-tab" } }, { rpc: handlers({ links: tabLinks, rpc: {
    getDraft: () => draft, getConversation: () => ({ threadId: "agent-1", legacy: [], defaults: null, machine: null }),
  } }) });
  const pane = await slot.findByRole("region", { name: "Review" });
  await within(pane).findByText("Snooze flaky checks");
  expect(within(pane).getByText("api:feat/qa", { selector: ".sr-only" })).toBeTruthy();
  const comments = await within(pane).findByRole("region", { name: /Comments/ });
  expect(within(comments).getByRole("heading").textContent).toBe("Comments · 2 open");
  const rows = within(comments).getAllByRole("listitem");
  expect(rows.map((row) => within(row).getAllByRole("button").length)).toEqual([1, 1, 1]);
  expect(within(comments).getByRole("button", { name: /Open · src\/a\.ts:1/ })).toBeTruthy();
  expect(within(comments).getByRole("button", { name: /Done · Logged it · src\/a\.ts:4/ })).toBeTruthy();
  expect(within(comments).getByRole("button", { name: /Resolved · src\/b\.ts:2/ })).toBeTruthy();
  const chat = within(slot.getByRole("region", { name: "Review agent" })).getByTestId("bb-thread-chat");
  expect([chat.dataset.threadId, chat.dataset.variant, chat.dataset.layout]).toEqual(["agent-1", "compact", "contained"]);
  // A comment's row, and Open review, open the review.
  fireEvent.click(within(comments).getByRole("button", { name: /Done · Logged it/ }));
  fireEvent.click(within(pane).getByRole("button", { name: "Open review" }));
  expect(slot.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "review", options: { subPath: "br-tab" } },
    { method: "toPluginPanel", path: "review", options: { subPath: "br-tab" } },
  ]);
});

test("before the review agent has started, the tab offers to ask it, in the review, starting none here; with no comments yet, says how to add one", async () => {
  localStorage.clear();
  const slot = renderSlot({ component: ReviewTab }, { threadId: "lead", environment: { id: "env-tab" } }, { rpc: handlers({ links: tabLinks, rpc: {
    getDraft: () => ({ draft: { ...draft.draft, comments: [] }, stale: [] }), getConversation: () => ({ threadId: null, legacy: [], defaults: null, machine: null }),
  } }) });
  expect(await slot.findByText("No questions yet.")).toBeTruthy();
  expect(await slot.findByText("No comments yet. Open the review to read the code and comment.")).toBeTruthy();
  expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Ask the review agent" }));
  expect(slot.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "br-tab" } }]);
  expect(getReviewState("br-tab").panel).toBe("agent");
  expect(slot.rpcCalls.map((call) => call.method).filter((method) => /startConversation|askAgent|newConversation/.test(method))).toEqual([]);
});

test("when the review agent's chat can't be read, the tab says so, with Try again", async () => {
  let fail = true;
  const slot = renderSlot({ component: ReviewTab }, { threadId: "lead", environment: { id: "env-tab" } }, { rpc: handlers({ links: tabLinks, rpc: {
    getDraft: () => draft, getConversation: () => { if (fail) throw new Error("HTTP 502"); return { threadId: "agent-2", legacy: [], defaults: null, machine: null }; },
  } }) });
  const alert = await slot.findByRole("alert");
  expect(alert.textContent).toContain("Couldn’t load the review agent’s chat.");
  expect(slot.queryByText("No questions yet.")).toBeNull();
  fail = false;
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  expect((await slot.findByTestId("bb-thread-chat")).dataset.threadId).toBe("agent-2");
});
