// @vitest-environment jsdom
// What a draft comment's card links to, in the code and in Comments' list: the thread Send to thread sent it to, and on
// a local review, the line in an editor.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ReviewLinks } from "../lib/review-links";

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

async function renderSent(links: Partial<ReviewLinks>) {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./draft-tray.test-support");
  const { DiffViewer } = await import("./DiffViewer");
  const { ReviewLinksContext } = await import("../lib/review-links");
  const component = () => <ReviewLinksContext.Provider value={{ sent: null, editor: null, ...links }}>
    <DraftTray targetKey="k" patch={patch} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" isLocal>
      <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />
    </DraftTray>
  </ReviewLinksContext.Provider>;
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: { targetKey: "k", verdict: "COMMENT", body: "", comments }, stale: [] }) } as any });
  await slot.findByText("Draft saved");
  return slot;
}

test("a sent comment's card says where it went and when, under its state, in the code and in the list; it's still not submitted", async () => {
  const now = Date.now();
  const slot = await renderSent({ sent: { at: now, threadId: "coder", title: "Retry uploads", comments: [{ file: "src/a.ts", line: 1, side: "RIGHT", at: now - 120_000 }] } });
  const diff = within(slot.getByTestId("filediff"));
  const sentCard = await diff.findByRole("article", { name: "Draft comment on src/a.ts:1" });
  expect(within(sentCard).getByText("Draft · not submitted")).toBeTruthy();
  const line = within(sentCard).getByText("Retry uploads").closest("p")!;
  expect(line.textContent).toBe("Sent to Retry uploads· 2m");
  // It follows the state line, before the comment's words.
  expect(line.compareDocumentPosition(within(sentCard).getByText("Name it.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(diff.getByRole("article", { name: "Draft comment on src/a.ts:3" })).queryByText(/Sent to/)).toBeNull();
  const list = within(slot.getByRole("region", { name: "Comments" }));
  fireEvent.click(list.getByRole("button", { name: /^Expand .*src\/a\.ts:1/ }));
  const listed = list.getByRole("article", { name: "Draft comment on src/a.ts:1" });
  expect(within(listed).getByText("Retry uploads").closest("p")!.textContent).toBe("Sent to Retry uploads· 2m");
  slot.lifecycle.unmount();
});

test("a comment edited since it was sent, or a new one at its line, doesn't say sent; one as sent does, and a record from 0.8.0 matches by place", async () => {
  const now = Date.now();
  const slot = await renderSent({ sent: { at: now, threadId: "coder", title: "Retry uploads", comments: [
    { file: "src/a.ts", line: 1, side: "RIGHT", body: "Name it.", at: now },
    { file: "src/a.ts", line: 3, side: "RIGHT", body: "Name it more.", at: now },
    // 0.8.0 recorded no body.
    { file: "src/a.ts", line: 2, side: "LEFT", at: now },
  ] } });
  const diff = within(slot.getByTestId("filediff"));
  expect(within(await diff.findByRole("article", { name: "Draft comment on src/a.ts:1" })).getByText("Retry uploads")).toBeTruthy();
  expect(within(diff.getByRole("article", { name: "Draft comment on src/a.ts:3" })).queryByText(/Sent to/)).toBeNull();
  expect(within(diff.getByRole("article", { name: "Draft comment on src/a.ts:2" })).getByText("Retry uploads")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("nothing says sent when nothing was, or Send to thread is off", async () => {
  const slot = await renderSent({ sent: null });
  await within(slot.getByTestId("filediff")).findByRole("article", { name: "Draft comment on src/a.ts:1" });
  expect(slot.queryByText(/Sent to/)).toBeNull();
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
