// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { getReviewState, patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre>{fileDiff.additionLines.join("\n")}</pre> }));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); restores.splice(0).forEach((restore) => restore()); });

/** A phone's screen: every ResizeObserver reports 390×844, and media queries answer for it. */
function phone() {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) { this.notify([{ target, contentRect: { width: 390, height: 844 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const max = query.match(/max-(width|height): (\d+)px/);
    const matches = !!max && (max[1] === "width" ? 390 : 844) <= Number(max[2]);
    return { matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as MediaQueryList;
  });
  restores.push(() => { globalThis.ResizeObserver = original; matchMedia.mockRestore(); });
}

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const patch = file("src/a.ts", "@@ -1 +1 @@\n-a\n+aa\n") + file("src/b.ts", "@@ -1,2 +1,2 @@\n x\n-b\n+bb\n");
const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[],
  sections: [
    { id: "c1", title: "Parsing", overview: "Reads rows.", risk: "high", focus: ["Check that an empty row is skipped.", "Check that `tenant` is kept."], diffs: [{ file: "src/a.ts", summary: "Reads a row." }] },
    { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/b.ts", summary: "Caches a row." }] },
  ],
};

function renderWorkspace(sent: object, { rpc = {}, review = () => ({}) }: { rpc?: Record<string, unknown>; review?: () => object } = {}) {
  // Opened before, on its first chapter: a first open shows the Overview.
  if (!getReviewState("pr-42").activeId) patchReviewState("pr-42", { activeId: "c1" });
  return loadPluginApp(() => import("../app")).then((app) => renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", ...review() }, guide: structuredClone(sent), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    ...rpc,
  } as any }));
}

test("a chapter's intro lists what to verify under its overview, and hides it with the overview", async () => {
  const slot = await renderWorkspace(guide);
  await slot.findByText("aa");
  const intro = within(slot.getByRole("region", { name: "Parsing" }));
  const focus = intro.getByRole("list", { name: "What to verify" });
  expect(within(focus).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Check that an empty row is skipped.", "Check that tenant is kept."]);
  fireEvent.click(intro.getByRole("button", { name: "Hide chapter overview" }));
  expect(intro.queryByRole("list", { name: "What to verify" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("a chapter without focus shows its overview alone", async () => {
  const slot = await renderWorkspace({ ...guide, sections: guide.sections.map(({ focus: _, ...section }: any) => section) });
  await slot.findByText("aa");
  expect(slot.queryByRole("list", { name: "What to verify" })).toBeNull();
  expect(within(slot.getByRole("region", { name: "Parsing" })).getByText("Reads rows.")).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("a chapter's intro says where it is, its risk, its size and how much of it you've viewed on one line, and Low risk goes unsaid", async () => {
  const slot = await renderWorkspace({ ...guide, sections: [guide.sections[0], { ...guide.sections[1], risk: "low" }] });
  await slot.findByText("aa");
  const intro = within(slot.getByRole("region", { name: "Parsing" }));
  const meta = intro.getByText("Chapter 1 of 2").parentElement!;
  // Each dot binds to the fact after it, so a wrapped line starts with one.
  expect(meta.textContent).toBe("Chapter 1 of 2 ·\u00a0High risk ·\u00a01 file ·\u00a02 lines ·\u00a00 of 1 viewed");
  // Each fact is still an element of its own, its dot outside it.
  expect(intro.getByText("0 of 1 viewed").textContent).toBe("0 of 1 viewed");
  expect(intro.getByText("High risk").className).toContain("rounded-full");
  fireEvent.keyDown(document.body, { key: "n" });
  const next = within(await slot.findByRole("region", { name: "Caching" }));
  expect(next.getByText("Chapter 2 of 2").parentElement!.textContent).toBe("Chapter 2 of 2 ·\u00a01 file ·\u00a02 lines ·\u00a00 of 1 viewed");
  slot.lifecycle.unmount();
}, 15_000);

test("on a phone the overview shows three lines until More, and what to verify one line until you open it", async () => {
  phone();
  // Three lines cut this overview short.
  const scrollHeight = vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return this.className.includes("max-h-") ? 120 : 0; });
  restores.push(() => scrollHeight.mockRestore());
  const slot = await renderWorkspace(guide);
  await slot.findByText("aa");
  const intro = within(slot.getByRole("region", { name: "Parsing" }));
  expect(intro.queryByRole("list", { name: "What to verify" })).toBeNull();
  const verify = intro.getByRole("button", { name: "What to verify · 2" });
  expect(verify.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(verify);
  expect(within(intro.getByRole("list", { name: "What to verify" })).getAllByRole("listitem")).toHaveLength(2);
  expect(verify.getAttribute("aria-expanded")).toBe("true");
  const overview = intro.getByText("Reads rows.");
  expect(overview.closest(".max-h-\\[4\\.25rem\\]")).toBeTruthy();
  expect(overview.closest("[class*='mask-image']")).toBeTruthy();
  fireEvent.click(intro.getByRole("button", { name: "More" }));
  expect(overview.closest(".max-h-\\[4\\.25rem\\]")).toBeNull();
  expect(intro.getByRole("button", { name: "Less" }).getAttribute("aria-expanded")).toBe("true");
  slot.lifecycle.unmount();
}, 15_000);

test("on a phone an overview three lines hold has no More, and doesn't fade", async () => {
  phone();
  const slot = await renderWorkspace({ ...guide, sections: guide.sections.map(({ focus: _, ...section }: any) => section) });
  await slot.findByText("aa");
  const intro = within(slot.getByRole("region", { name: "Parsing" }));
  expect(intro.getByText("Reads rows.").closest("[class*='mask-image']")).toBeNull();
  expect(intro.queryByRole("button", { name: "More" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("What to verify ends with Dig deeper on medium- and high-risk chapters, which asks the agent and says it's digging until its turn ends", async () => {
  let deepDive: object | null = null;
  const digDeeper = vi.fn(({ chapterId }: { chapterId: string }) => {
    deepDive = { chapterId, ask: { threadId: "assistant", state: "running", at: Date.now() } };
    return { ok: true };
  });
  const sections = [guide.sections[0], { ...guide.sections[1], risk: "medium", focus: ["Check that the cache expires."] }];
  const slot = await renderWorkspace({ ...guide, sections }, { rpc: { digDeeper }, review: () => ({ deepDive }) });
  await slot.findByText("aa");
  const intro = within(slot.getByRole("region", { name: "Parsing" }));
  fireEvent.click(intro.getByRole("button", { name: "Dig deeper" }));
  expect(digDeeper).toHaveBeenCalledWith({ targetKey: "pr-42", chapterId: "c1" });
  await slot.emitRealtime("review:pr-42", {});
  await intro.findByText("The agent is digging into this chapter…");
  expect(intro.getByRole("status").textContent).toBe("The agent is digging into this chapter…");
  expect(intro.queryByRole("button", { name: "Dig deeper" })).toBeNull();
  // The medium-risk chapter offers it too, while another chapter's deep dive is under way, not yet.
  fireEvent.keyDown(document.body, { key: "n" });
  const next = within(await slot.findByRole("region", { name: "Caching" }));
  expect((next.getByRole("button", { name: "Dig deeper" }) as HTMLButtonElement).disabled).toBe(true);
  // The assistant's turn ends.
  deepDive = null;
  await slot.emitRealtime("review:pr-42", {});
  await waitFor(() => expect((next.getByRole("button", { name: "Dig deeper" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.keyDown(document.body, { key: "p" });
  const back = within(await slot.findByRole("region", { name: "Parsing" }));
  expect(back.queryByText("The agent is digging into this chapter…")).toBeNull();
  expect(back.getByRole("button", { name: "Dig deeper" })).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("a low-risk chapter offers no Dig deeper, nor does a merged PR's", async () => {
  const lowRisk = await renderWorkspace({ ...guide, sections: [{ ...guide.sections[0], risk: "low" }, guide.sections[1]] });
  await lowRisk.findByText("aa");
  expect(lowRisk.getByRole("list", { name: "What to verify" })).toBeTruthy();
  expect(lowRisk.queryByRole("button", { name: "Dig deeper" })).toBeNull();
  lowRisk.lifecycle.unmount();
  const merged = await renderWorkspace(guide, { review: () => ({ prState: "MERGED" }) });
  await merged.findByText("aa");
  expect(merged.queryByRole("button", { name: "Dig deeper" })).toBeNull();
  merged.lifecycle.unmount();
}, 15_000);

test("Dig deeper's refusal is said in a toast", async () => {
  const { toast } = await import("sonner");
  const slot = await renderWorkspace(guide, { rpc: { digDeeper: () => ({ ok: false, error: "Choose this review's agent first." }) } });
  await slot.findByText("aa");
  fireEvent.click(slot.getByRole("button", { name: "Dig deeper" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Choose this review's agent first."));
  expect(slot.queryByText("The agent is digging into this chapter…")).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("Dig deeper's tooltip names the review agent's model and the effort", async () => {
  const { act } = await import("@testing-library/react");
  const assistantAgent = { providerId: "codex", model: "gpt-6", reasoningLevel: "medium", permissionMode: "auto" };
  const slot = await renderWorkspace(guide, { rpc: { getPreferences: () => ({ preferences: { ...defaultPreferences, assistantAgent }, revision: 0 }) } });
  await slot.findByText("aa");
  const button = slot.getByRole("button", { name: "Dig deeper" });
  await waitFor(() => { act(() => { button.blur(); button.focus(); }); expect(slot.getByRole("tooltip").textContent).toBe("Review agent · gpt-6 · high effort"); });
  slot.lifecycle.unmount();
}, 15_000);
