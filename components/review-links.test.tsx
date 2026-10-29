// @vitest-environment jsdom
// What a draft comment's card says and links to, in the code and in Comments' list: its one status line, which on your
// own change follows its Sends to the main thread, and on a local review, the line in an editor.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ReviewLinks } from "../lib/review-links";
import type { StatusFacts } from "../lib/comments";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Pierre's annotations at its rows, new lines 1–3 and old lines 1–2, not its internals.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => <div data-testid="filediff">
    {lineAnnotations?.filter((a: any) => a.lineNumber <= (a.side === "additions" ? 3 : 2)).map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
  </div>,
}));

afterEach(() => { cleanup(); sessionStorage.clear(); vi.useRealTimers(); });

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n-gone\n+new\n+more\n+most\n";
const comments = [{ file: "src/a.ts", line: 1, side: "RIGHT", body: "Name it." }, { file: "src/a.ts", line: 3, side: "RIGHT", body: "Not sent." }, { file: "src/a.ts", line: 2, side: "LEFT", body: "Why drop it?" }];

const LOCAL: StatusFacts = { posts: false, own: true };

async function renderSent(links: Partial<ReviewLinks>, drafted: readonly unknown[] = comments) {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./draft-tray.test-support");
  const { DiffViewer } = await import("./DiffViewer");
  const { ReviewLinksContext } = await import("../lib/review-links");
  const component = () => <ReviewLinksContext.Provider value={{ status: LOCAL, editor: null, ...links }}>
    <DraftTray targetKey="k" patch={patch} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" isLocal>
      <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />
    </DraftTray>
  </ReviewLinksContext.Provider>;
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: { targetKey: "k", verdict: "COMMENT", body: "", comments: drafted }, stale: [] }) } as any });
  await slot.findByText("Draft saved");
  return slot;
}
/** A card's one status line: what follows its icon in its head. */
const statusOf = async (slot: Awaited<ReturnType<typeof renderSent>>, name: string) => (await within(slot.getByTestId("filediff")).findByRole("article", { name })).querySelector(":scope > div > span")!.textContent;

test("on a local review each card has one status: Open, Queued for or Sent to its thread in Send n and when, Done or Declined as reported, Resolved", async () => {
  const now = Date.now();
  const drafted = [
    { file: "src/a.ts", line: 1, side: "RIGHT", body: "Name it.", id: "c1", state: "sent", sendN: 2 },
    { file: "src/a.ts", line: 3, side: "RIGHT", body: "Not sent.", author: "agent" },
    { file: "src/a.ts", line: 2, side: "LEFT", body: "Why drop it?", id: "c3", state: "sent", sendN: 3, claim: { outcome: "declined", note: "It's dead code", threadId: "coder", at: now } },
  ];
  const sends = [{ n: 2, at: now - 120_000, threadId: "coder", ids: ["c1"] }, { n: 3, at: now, threadId: "coder", ids: ["c3"] }];
  const slot = await renderSent({ status: { ...LOCAL, sends, sent: { at: now, threadId: "coder", title: "Retry uploads", comments: [] } } }, drafted);
  expect(await statusOf(slot, "Draft comment on src/a.ts:1")).toBe("Sent to Retry uploads · Send 2 · 2m");
  expect(await statusOf(slot, "Draft comment on src/a.ts:3")).toBe("Agent · Open");
  expect(await statusOf(slot, "Draft comment on src/a.ts:2")).toBe("Declined · It's dead code · now");
  // Nothing on a local review is a draft not submitted, nor says two things.
  expect(within(slot.getByTestId("filediff")).queryByText(/not submitted/)).toBeNull();
  // The list's rows say the same.
  const list = within(slot.getByRole("region", { name: "Comments" }));
  const row = list.getByRole("button", { name: /^Sent to Retry uploads · Send 2 · src\/a\.ts:1/ });
  expect(within(row).getByText("Sent to Retry uploads · Send 2")).toBeTruthy();
  expect(within(list.getByRole("button", { name: /^Agent · Open · src\/a\.ts:3/ })).getByText("Agent · Open")).toBeTruthy();
  slot.lifecycle.unmount();
  cleanup();
  // Still in the thread's queue, it's queued; then resolved by your click.
  const queued = await renderSent({ status: { ...LOCAL, sends: [{ ...sends[0]!, queued: "q1" }] } }, [drafted[0], { file: "src/a.ts", line: 3, side: "RIGHT", body: "Not sent.", id: "c2", state: "resolved" }]);
  expect(await statusOf(queued, "Draft comment on src/a.ts:1")).toBe("Queued for the main thread · Send 2 · 2m");
  expect(await statusOf(queued, "Draft comment on src/a.ts:3")).toBe("Resolved");
  queued.lifecycle.unmount();
});

test("where comments post to GitHub, an open one is a draft not submitted; a sent one stays so on someone else's PR, and on yours is sent", async () => {
  const now = Date.now();
  const drafted = [{ file: "src/a.ts", line: 1, side: "RIGHT", body: "Name it.", id: "c1", state: "sent", sendN: 1 }, { file: "src/a.ts", line: 3, side: "RIGHT", body: "Not sent." }];
  const status = { sends: [{ n: 1, at: now, threadId: "coder", ids: ["c1"] }], sent: { at: now, threadId: "coder", title: "Retry uploads", comments: [] } };
  const theirs = await renderSent({ status: { posts: true, own: false, ...status } }, drafted);
  expect(await statusOf(theirs, "Draft comment on src/a.ts:1")).toBe("Draft · not submitted · Sent to Retry uploads · Send 1 · now");
  expect(await statusOf(theirs, "Draft comment on src/a.ts:3")).toBe("Draft · not submitted");
  theirs.lifecycle.unmount();
  cleanup();
  const yours = await renderSent({ status: { posts: true, own: true, ...status } }, drafted);
  expect(await statusOf(yours, "Draft comment on src/a.ts:1")).toBe("Sent to Retry uploads · Send 1 · now");
  expect(await statusOf(yours, "Draft comment on src/a.ts:3")).toBe("Draft · not submitted");
  yours.lifecycle.unmount();
});

test("a comment sent before 1.8.0 says so while it reads as sent; edited since, or a new one at its line, it doesn't; a record from 0.8.0 matches by place", async () => {
  const now = Date.now();
  const slot = await renderSent({ status: { ...LOCAL, sent: { at: now, threadId: "coder", title: "Retry uploads", comments: [
    { file: "src/a.ts", line: 1, side: "RIGHT", body: "Name it.", at: now - 120_000 },
    { file: "src/a.ts", line: 3, side: "RIGHT", body: "Name it more.", at: now },
    // 0.8.0 recorded no body.
    { file: "src/a.ts", line: 2, side: "LEFT", at: now },
  ] } } });
  expect(await statusOf(slot, "Draft comment on src/a.ts:1")).toBe("Sent to Retry uploads · 2m");
  expect(await statusOf(slot, "Draft comment on src/a.ts:3")).toBe("Open");
  expect(await statusOf(slot, "Draft comment on src/a.ts:2")).toBe("Sent to Retry uploads · now");
  slot.lifecycle.unmount();
});

test("on a local review, a comment's ⋯ opens its line in an editor on the BB server; not a comment on removed lines, nor without the editor", async () => {
  const slot = await renderSent({ editor: { hostId: "server", root: "/repo" } });
  const diff = within(slot.getByTestId("filediff"));
  const card = await diff.findByRole("article", { name: "Draft comment on src/a.ts:1" });
  fireEvent.click(within(card).getByRole("button", { name: "More on the comment on src/a.ts:1" }));
  fireEvent.click(await slot.findByRole("link", { name: "Open in editor at line 1" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "experimental_openFilePreview", options: { target: { kind: "host", hostId: "server", path: "/repo/src/a.ts" }, location: { kind: "line", line: 1, column: null } } });
  expect(within(diff.getByRole("article", { name: "Draft comment on src/a.ts:2" })).queryByRole("button", { name: /^More on/ })).toBeNull();
  // In Comments' list too.
  const list = within(slot.getByRole("region", { name: "Comments" }));
  fireEvent.click(list.getByRole("button", { name: /^Expand .*src\/a\.ts:3/ }));
  expect(within(list.getByRole("article", { name: "Draft comment on src/a.ts:3" })).getByRole("button", { name: "More on the comment on src/a.ts:3" })).toBeTruthy();
  slot.lifecycle.unmount();
  cleanup();
  const none = await renderSent({ editor: null });
  await within(none.getByTestId("filediff")).findByRole("article", { name: "Draft comment on src/a.ts:1" });
  expect(none.queryByRole("button", { name: /^More on the comment/ })).toBeNull();
  none.lifecycle.unmount();
});

test("a local review's comment opens in an editor only where its diff ends at the checkout: main and main...HEAD, not main...feature or a..b", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewLinksContext, useReviewLinks } = await import("../lib/review-links");
  const { CommentEditorMenu } = await import("./OpenInEditor");
  const comment = { file: "src/a.ts", line: 1, side: "RIGHT" as const, body: "Name it." };
  const offered = async (gitRef: string) => {
    const component = () => {
      const links = useReviewLinks({ targetKey: "k", kind: "ref", gitRef, cwd: "/repo", status: "ready", createdAt: 1, title: gitRef } as any);
      return <ReviewLinksContext.Provider value={links}><CommentEditorMenu comment={comment} /></ReviewLinksContext.Provider>;
    };
    const listMachines = vi.fn(() => ({ machines: [{ hostId: "server", name: "Server", connected: true, server: true }] }));
    const slot = renderSlot({ component }, {}, { rpc: { listMachines } as any });
    // Wait out the machines, which an offered review asks for.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const button = slot.queryByRole("button", { name: "More on the comment on src/a.ts:1" });
    slot.lifecycle.unmount();
    cleanup();
    return { offered: button !== null, asked: listMachines.mock.calls.length > 0 };
  };
  expect(await offered("main")).toEqual({ offered: true, asked: true });
  expect(await offered("main...HEAD")).toEqual({ offered: true, asked: true });
  expect(await offered("main...feature")).toEqual({ offered: false, asked: false });
  expect(await offered("a..b")).toEqual({ offered: false, asked: false });
});

test("on your own change a sent comment's icon says where its fix stands, and a reported note shows its code as code, nothing else", async () => {
  const now = Date.now();
  const drafted = [
    { file: "src/a.ts", line: 1, side: "RIGHT", body: "Name it.", id: "c1", state: "sent", sendN: 1, claim: { outcome: "done", note: "Renamed it `total` <b>now</b>.", threadId: "coder", at: now } },
    { file: "src/a.ts", line: 3, side: "RIGHT", body: "Not sent.", id: "c2", state: "sent", sendN: 1, claim: { outcome: "done", note: "a.ts:3", threadId: "agent", at: now, inferred: true } },
    { file: "src/a.ts", line: 2, side: "LEFT", body: "Why drop it?", id: "c3", state: "sent", sendN: 1 },
  ];
  const slot = await renderSent({ status: { ...LOCAL, sends: [{ n: 1, at: now, threadId: "coder", ids: ["c1", "c2", "c3"] }] } }, drafted);
  const card = async (name: string) => within(slot.getByTestId("filediff")).findByRole("article", { name });
  const icon = async (name: string) => (await card(name)).querySelector(":scope > div > span > svg")!.getAttribute("data-icon");
  // The thread's words, without their closing stop; its code as code, and markup as the text it is.
  expect(await statusOf(slot, "Draft comment on src/a.ts:1")).toBe("Done · Renamed it total <b>now</b> · now");
  expect((await card("Draft comment on src/a.ts:1")).querySelector("code")?.textContent).toBe("total");
  expect((await card("Draft comment on src/a.ts:1")).querySelector("b")).toBeNull();
  expect(await icon("Draft comment on src/a.ts:1")).toBe("Check");
  expect(await statusOf(slot, "Draft comment on src/a.ts:3")).toBe("Looks done · not reported · now");
  expect(await icon("Draft comment on src/a.ts:3")).toBe("CircleCheck");
  expect(await icon("Draft comment on src/a.ts:2")).toBe("Send");
  slot.lifecycle.unmount();
});
