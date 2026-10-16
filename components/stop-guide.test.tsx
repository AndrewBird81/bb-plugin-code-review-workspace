// Stop, while a guide builds: on the building card, and on a rebuild's notice; a rebuild goes back to the guide you had.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { defaultKnobs } from "../lib/knobs";
import { settingsOffRpc } from "./settings-off.test-support";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, Toaster: () => null }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const review = { targetKey: "pr-42", kind: "pr", createdAt: 1, title: "Parse rows", headSha: "new", url: "https://github.com/acme/web/pull/42", repo: "acme/web", number: 42 };

/** The review's page, its guide building (`guide` false) or shown, with `stopGuide` answering as given. */
async function renderPage(knobs: typeof defaultKnobs, state: { status: string; guide: boolean; guideError?: { at: number; text: string } }, stopGuide = vi.fn((): unknown => ({ ok: true }))) {
  const app = await loadPluginApp(() => import("../app"));
  const base = settingsOffRpc(knobs);
  const rpc = settingsOffRpc(knobs, {
    getReviewBundle: () => {
      const bundle = base.getReviewBundle() as { guide: unknown; patch: string; revision: string };
      return { ...bundle, review: { ...review, status: state.status, ...(state.guideError ? { guideError: state.guideError } : {}) }, guide: state.guide ? bundle.guide : null };
    },
    stopGuide,
  });
  const page = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: rpc as any });
  return { page, stopGuide };
}

test("the building card offers Stop beside Open on GitHub, and a stopped first guide says Guide stopped, with Build the guide", async () => {
  const state = { status: "generating", guide: false } as { status: string; guide: boolean; guideError?: { at: number; text: string } };
  const { page, stopGuide } = await renderPage(defaultKnobs, state, vi.fn(() => {
    Object.assign(state, { status: "error", guideError: { at: 1, text: "Stopped" } });
    return { ok: true };
  }));
  const card = await page.findByRole("status", { name: "Building the guide" });
  expect(card.querySelector("a[href='https://github.com/acme/web/pull/42']")).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Stop" }));
  expect(stopGuide).toHaveBeenCalledWith({ targetKey: "pr-42" });
  await page.findByRole("heading", { name: "Guide stopped" });
  expect(page.getByRole("button", { name: "Build the guide" })).toBeTruthy();
  // Nothing went wrong, so there's no reason to show, nor an alert.
  expect(page.queryByText("What went wrong")).toBeNull();
  expect(page.queryByRole("alert")).toBeNull();
  expect(toast.success).not.toHaveBeenCalled();
  page.lifecycle.unmount();
});

test("a rebuild's notice offers Stop, which puts the guide back and says so", async () => {
  const state = { status: "ready", guide: true };
  const { page } = await renderPage(defaultKnobs, state, vi.fn(() => {
    Object.assign(state, { status: "ready", guide: true });
    return { ok: true, restored: true };
  }));
  await page.findByRole("main", { name: "Review" });
  // The guide is rebuilt: the workspace keeps the one it showed, under the notice.
  Object.assign(state, { status: "generating", guide: false });
  await page.emitRealtime("review:pr-42", {});
  await page.findByText(/Updating the guide for the new commits/);
  fireEvent.click(page.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Stopped. The guide is as it was."));
  await waitFor(() => expect(page.queryByText(/Updating the guide for the new commits/)).toBeNull());
  page.lifecycle.unmount();
});

test("a guide that failed still says why, with Try again", async () => {
  const { page } = await renderPage(defaultKnobs, { status: "error", guide: false, guideError: { at: 1, text: "The guide writer failed." } });
  await page.findByRole("heading", { name: "Couldn’t build the guide" });
  expect(page.getByText("The guide writer failed.")).toBeTruthy();
  expect(page.getByRole("button", { name: "Try again" })).toBeTruthy();
  page.lifecycle.unmount();
});
