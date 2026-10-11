// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { defaultPreferences } from "../src/preferences";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// What pierre is given: whether it has the whole file, and whether to show all of it. The gutter "+" picks a line.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options, lineAnnotations, renderAnnotation }: any) => {
    const plus = (line: number) => () => options.onGutterUtilityClick({ start: line, end: line, side: "additions" });
    return (
      <div data-testid="filediff" data-partial={String(fileDiff.isPartial)} data-whole={String(!!options.expandUnchanged)}>
        <pre>{fileDiff.additionLines.join("")}</pre>
        {lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
        <button onClick={plus(1)}>Gutter + line 1</button>
        <button onClick={plus(3)}>Gutter + line 3</button>
      </div>
    );
  },
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,2 +2,2 @@\n two\n-three\n+THREE\n";
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] }] };
const contents = { ok: true, old: "one\ntwo\nthree\nfour\n", new: "one\ntwo\nTHREE\nfour\n" };

async function renderWorkspace(rpc: Record<string, unknown> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [{ file: "src/a.ts", line: 3, side: "RIGHT", body: "Why upper case?", author: "reviewer" }] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getFileContents: vi.fn(() => contents),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("heading", { name: "Parse rows" });
  await slot.findByTestId("filediff");
  return { slot, rpc: handlers, file: () => within(slot.container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!) };
}

test("Expand loads the whole file into the diff, keeping its comments, and Whole file shows all of it", async () => {
  const { slot, rpc, file } = await renderWorkspace();
  expect(file().getByTestId("filediff").dataset.partial).toBe("true");
  fireEvent.click(file().getByRole("button", { name: "Expand src/a.ts around its changes" }));
  await waitFor(() => expect(file().getByTestId("filediff").dataset.partial).toBe("false"));
  expect(rpc.getFileContents).toHaveBeenCalledWith({ targetKey: "pr-42", file: "src/a.ts" });
  expect(file().getByText(/one\s*two\s*THREE\s*four/)).toBeTruthy();
  expect(file().getByRole("article", { name: "Draft comment on src/a.ts:3" })).toBeTruthy();
  const whole = file().getByRole("button", { name: "Whole file src/a.ts" });
  expect(whole.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(whole);
  await waitFor(() => expect(file().getByTestId("filediff").dataset.whole).toBe("true"));
  expect(whole.getAttribute("aria-pressed")).toBe("true");
  slot.lifecycle.unmount();
});

test("a file that can't be expanded keeps its diff and says why", async () => {
  const { slot, file } = await renderWorkspace({ getFileContents: () => ({ ok: false, error: "The file doesn’t match the diff, so only the diff shows." }) });
  fireEvent.click(file().getByRole("button", { name: "Expand src/a.ts around its changes" }));
  await file().findByText("The file doesn’t match the diff, so only the diff shows.");
  expect(file().getByTestId("filediff").dataset.partial).toBe("true");
  slot.lifecycle.unmount();
});

test("in an expanded file, a comment goes only on a line GitHub takes one on", async () => {
  const { slot, file } = await renderWorkspace();
  fireEvent.click(file().getByRole("button", { name: "Expand src/a.ts around its changes" }));
  await waitFor(() => expect(file().getByTestId("filediff").dataset.partial).toBe("false"));
  fireEvent.click(file().getByRole("button", { name: "Gutter + line 1" }));
  expect(toast.info).toHaveBeenCalledWith("GitHub takes comments only on lines in the diff.");
  expect(file().queryByRole("textbox", { name: "Draft comment" })).toBeNull();
  fireEvent.click(file().getByRole("button", { name: "Gutter + line 3" }));
  expect(await file().findByRole("textbox", { name: "Draft comment" })).toBeTruthy();
  slot.lifecycle.unmount();
});
