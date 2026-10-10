// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { toast } = await import("sonner");

afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); });

async function renderTray(targetKey: string, rpc: Record<string, unknown>, props: Record<string, unknown> = {}) {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  const component = () => <DraftTray targetKey={targetKey} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" {...props} />;
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), ...rpc } as any });
  await slot.findByText("Draft saved");
  return slot;
}
type Slot = Awaited<ReturnType<typeof renderTray>>;
const draftOf = (over: Record<string, unknown> = {}): Record<string, any> => ({ targetKey: "k", verdict: "COMMENT", body: "", comments: [] as any[], ...over });
const status = (slot: Slot) => within(slot.getByRole("region", { name: "Review draft" })).getAllByRole("status")[0];

/** Write a comment in the panel's Add comment form. */
function writeComment(slot: Slot, text: string) {
  fireEvent.click(slot.getByRole("button", { name: "Add comment" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Draft comment" }), { target: { value: text } });
}

test("the status line follows saves: a failed submit's error clears when a later save works, and a failed save says so", async () => {
  let draft = draftOf({ body: "Summary." });
  let fail = false;
  const saveDraftComment = vi.fn(async ({ comment }: any) => {
    if (fail) throw new Error("Couldn’t reach the server.");
    draft = { ...draft, comments: [comment] };
    return { draft, stale: [], discussions: [] };
  });
  const submitReview = vi.fn(async () => ({ ok: false, error: "GitHub said no." }));
  const slot = await renderTray("status", { getDraft: () => ({ draft, stale: [], discussions: [] }), saveDraftComment, submitReview });
  fireEvent.click(slot.getByRole("button", { name: "Submit to GitHub" }));
  await waitFor(() => expect(status(slot).textContent).toBe("GitHub said no."));
  writeComment(slot, "One.");
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(status(slot).textContent).toBe("Draft saved"));
  fail = true;
  writeComment(slot, "Two.");
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(status(slot).textContent).toBe("Couldn’t reach the server."));
  slot.lifecycle.unmount();
});
