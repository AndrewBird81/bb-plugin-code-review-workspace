// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DraftProviderProps } from "./DraftProvider";

afterEach(cleanup);

/** The draft's provider with Comments and Finish review after what it wraps, as the side panel shows them. */
async function draftTray() {
  const { DraftTray } = await import("./draft-tray.test-support");
  return DraftTray;
}
const account = () => ({ active: "reviewer", accounts: [{ login: "reviewer", active: true }] });

test("list load failure is distinct from an empty account and can recover", async () => {
  let offline = true;
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: account,
    listReviews: () => { if (offline) throw new Error("offline"); return { reviews: [{ targetKey: "repo-pr-7", title: "Preserved review", status: "ready" }] }; },
  } });
  await slot.findByText("Couldn’t load your reviews");
  // Not the first run's panel, which is for having no reviews.
  expect(slot.queryByRole("region", { name: "Review your first pull request" })).toBeNull();
  offline = false;
  fireEvent.click(slot.getByRole("button", { name: "Try again" }));
  await slot.findByText("Preserved review");
  slot.lifecycle.unmount();
});

test("workspace load failure has retry instead of an endless generation skeleton", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "missing" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => { throw new Error("Connection lost"); },
    getGuide: () => ({ guide: null, status: "generating" }),
    getPatch: () => ({ patch: "" }), getChecks: () => ({ bucket: "none", checks: [] }),
  } });
  await slot.findByText("Couldn’t load this review");
  expect(slot.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "All reviews" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a saved summary persists; submit is explicit and locked", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  let stored = { targetKey: "pr-7", verdict: "COMMENT", body: "", comments: [] };
  const saveSummary = vi.fn(async (input: any) => { stored = { ...stored, body: input.body }; return { draft: stored, stale: [], discussions: [] }; });
  let release: (result: { ok: boolean }) => void = () => {};
  const submitReview = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { release = resolve; }));
  const slot = renderSlot({ component: (props: any) => <DraftTray {...props} /> }, { targetKey: "pr-7", activeChapterId: "core", activeFiles: ["file.ts"] }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getDraft: () => ({ draft: stored }), saveSummary, submitReview,
  } });
  await slot.findByText("Draft saved");
  expect(submitReview).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Write summary" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Review summary" }), { target: { value: "A considered review" } });
  // Unsaved text holds the submission back.
  expect(slot.getByRole("button", { name: /^Submit to GitHub/ }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(slot.getByRole("button", { name: "Save summary" }));
  await waitFor(() => expect(stored.body).toBe("A considered review"));
  await slot.findByText("A considered review");
  const submit = slot.getByRole("button", { name: /^Submit to GitHub/ });
  fireEvent.click(submit); fireEvent.click(submit);
  await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1));
  release({ ok: false });
  await slot.findByRole("button", { name: /^Submit to GitHub/ });
  expect(stored.body).toBe("A considered review");
  slot.lifecycle.unmount();
});

test("local review keeps draft notes but never offers GitHub submission", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const slot = renderSlot({ component: (props: any) => <DraftTray {...props} /> }, { targetKey: "ref-local", activeChapterId: "core", activeFiles: ["file.ts"], isLocal: true }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getDraft: () => ({ draft: { targetKey: "ref-local", verdict: "COMMENT", body: "", comments: [] } }),
  } });
  await slot.findByText("Local review. Comments and notes stay in this BB installation.");
  expect(slot.queryByRole("button", { name: /^Submit to GitHub/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("failed draft loading blocks edits and preserves the stored draft", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const setVerdict = vi.fn();
  const slot = renderSlot({ component: (props: any) => <DraftTray {...props} /> }, { targetKey: "pr-7", activeChapterId: "core", activeFiles: [] }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getDraft: () => { throw new Error("offline"); }, setVerdict,
  } });
  // Comments and Finish review both say so.
  expect((await slot.findAllByRole("button", { name: "Retry draft" })).length).toBeGreaterThan(0);
  expect(slot.queryByRole("button", { name: /^Submit to GitHub/ })).toBeNull();
  expect(setVerdict).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
});

test("a later dismissed approval replaces the local success receipt", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const { useState } = await import("react");
  const { act } = await import("@testing-library/react");
  let updateReview!: (review: any) => void;
  let draft = { targetKey: "pr-7", verdict: "APPROVE", body: "", comments: [] };
  const slot = renderSlot({ component: () => {
    const [review, setReview] = useState<any>({ targetKey: "pr-7", status: "ready" });
    updateReview = setReview;
    return <DraftTray targetKey="pr-7" activeChapterId="core" activeFiles={[]} review={review} onSubmitted={() => setReview({ targetKey: "pr-7", status: "ready", submittedVerdict: "APPROVE" })} />;
  } }, {}, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getDraft: () => ({ draft }),
    submitReview: () => { draft = { ...draft, verdict: "COMMENT" }; return { ok: true }; },
  } });
  fireEvent.click(await slot.findByRole("button", { name: /^Submit to GitHub/ }));
  await slot.findByRole("region", { name: "Submitted review" });
  act(() => updateReview({ targetKey: "pr-7", status: "ready", submittedVerdict: null }));
  expect(slot.queryByRole("region", { name: "Submitted review" })).toBeNull();
  expect(slot.getByRole("button", { name: /^Submit to GitHub/ })).toBeTruthy();
});
