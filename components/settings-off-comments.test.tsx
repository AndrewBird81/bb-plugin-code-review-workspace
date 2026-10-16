// With every settings knob off, the Overview shows no Requirements, no line shows a CI failure, and text selected in
// the code offers nothing, while a comment on selected lines and Submit still work.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { allKnobsOff, desktopWindow, renderReview } from "./settings-off.test-support";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, Toaster: () => null }));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options, lineAnnotations, renderAnnotation }: any) => {
    const pick = () => { const range = { start: 1, end: 1, side: "additions" }; options.onLineSelectionStart?.(range); options.onLineSelectionEnd?.(range); options.onLineSelected?.(range); };
    return <div data-testid="filediff">
      {fileDiff.additionLines.map((text: string, index: number) => <span key={index}>{text}</span>)}
      {lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
      <button onClick={pick}>Pick line 1 of {fileDiff.name}</button>
    </div>;
  },
}));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); window.getSelection()?.removeAllRanges(); restores.splice(0).forEach((restore) => restore()); });

test("with every knob off, no Requirements, CI note or text bar shows, and a comment on selected lines and Submit still work", async () => {
  restores.push(desktopWindow());
  const saveDraftComment = vi.fn(async ({ comment }: any) => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [comment] }, stale: [], discussions: [] }));
  const submitReview = vi.fn(() => ({ ok: true, url: "https://github.com/acme/web/pull/42#pullrequestreview-9" }));
  const { page, bar, main } = await renderReview(allKnobsOff, { saveDraftComment, submitReview });

  // The Overview: its failing check, and no Requirements.
  await page.findByRole("heading", { name: "Parse rows" });
  await waitFor(() => expect(page.queryByRole("region", { name: /Requirements/ })).toBeNull());
  expect(within(page.getByRole("region", { name: "Checks" })).getByText("test")).toBeTruthy();

  // A chapter: no CI failure on its line, and none read.
  fireEvent.click(await main().findByRole("button", { name: "Start reading: Parsing" }));
  await page.findAllByTestId("filediff");
  const code = within(page.container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!);
  expect(page.queryByRole("note", { name: "CI failure on src/a.ts:2" })).toBeNull();
  expect(page.inspection.rpcCalls.some((call) => call.method === "getCheckFailures")).toBe(false);

  // Text selected in the code offers nothing.
  const range = document.createRange();
  range.selectNodeContents(code.getByText("TWO"));
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(page.queryByRole("group", { name: "Selection" })).toBeNull();
  window.getSelection()!.removeAllRanges();

  // Selected lines still take a comment.
  fireEvent.click(code.getByRole("button", { name: "Pick line 1 of src/a.ts" }));
  fireEvent.click(within(page.getByRole("group", { name: "Selection" })).getByRole("button", { name: "Comment" }));
  fireEvent.change(await code.findByRole("textbox", { name: "Draft comment" }), { target: { value: "Name the row." } });
  fireEvent.click(code.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ comment: expect.objectContaining({ file: "src/a.ts", line: 1, side: "RIGHT", body: "Name the row." }) })));

  // Submit still sends.
  fireEvent.click(await within(await bar.findByRole("group", { name: "Review commands" })).findByRole("button", { name: /^Finish review:/ }));
  const draft = within(await page.findByRole("region", { name: "Review draft" }));
  fireEvent.click(await draft.findByRole("button", { name: /^Submit to GitHub/ }));
  await waitFor(() => expect(submitReview).toHaveBeenCalled());
  page.lifecycle.unmount(); bar.lifecycle.unmount();
}, 20_000);
