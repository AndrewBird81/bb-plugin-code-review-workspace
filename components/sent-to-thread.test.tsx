// @vitest-environment jsdom
// A draft comment Send to thread sent says so on its card, in the code and in Comments' list, and is still only in BB.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ReviewLinks } from "../lib/review-links";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Pierre's annotations at new lines 1 and 2, not its internals.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => <div data-testid="filediff">
    {lineAnnotations?.filter((a: any) => a.side === "additions" && a.lineNumber <= 2).map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
  </div>,
}));

afterEach(() => { cleanup(); sessionStorage.clear(); vi.useRealTimers(); });

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n";
const comments = [{ file: "src/a.ts", line: 1, side: "RIGHT", body: "Name it." }, { file: "src/a.ts", line: 2, side: "RIGHT", body: "Not sent." }];

async function renderSent(links: ReviewLinks) {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./draft-tray.test-support");
  const { DiffViewer } = await import("./DiffViewer");
  const { ReviewLinksContext } = await import("../lib/review-links");
  const component = () => <ReviewLinksContext.Provider value={links}>
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
  expect(within(diff.getByRole("article", { name: "Draft comment on src/a.ts:2" })).queryByText(/Sent to/)).toBeNull();
  const list = within(slot.getByRole("region", { name: "Comments" }));
  fireEvent.click(list.getByRole("button", { name: /^Expand .*src\/a\.ts:1/ }));
  const listed = list.getByRole("article", { name: "Draft comment on src/a.ts:1" });
  expect(within(listed).getByText("Retry uploads").closest("p")!.textContent).toBe("Sent to Retry uploads· 2m");
  slot.lifecycle.unmount();
});

test("nothing says sent when nothing was, or Send to thread is off", async () => {
  const slot = await renderSent({ sent: null });
  await within(slot.getByTestId("filediff")).findByRole("article", { name: "Draft comment on src/a.ts:1" });
  expect(slot.queryByText(/Sent to/)).toBeNull();
  slot.lifecycle.unmount();
});
