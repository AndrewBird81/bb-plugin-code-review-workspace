// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div /> }));
installTestPluginRuntime();
const { DiffViewer } = await import("./DiffViewer");

afterEach(cleanup);

const file = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;

test("a file's header names its CODEOWNERS owners and marks the files that are yours", () => {
  const owners = new Map([
    ["src/a.ts", { file: "src/a.ts", owners: ["@acme/web", "@bob"], mine: true }],
    ["src/b.ts", { file: "src/b.ts", owners: ["@carol"], mine: false }],
  ]);
  const { container } = render(<DiffViewer patch={file("src/a.ts") + file("src/b.ts") + file("src/c.ts")} files={["src/a.ts", "src/b.ts", "src/c.ts"]} views={new Map()} onToggleViewed={() => {}} owners={owners} />);
  const header = (path: string) => within(container.querySelector<HTMLElement>(`[data-file="${path}"]`)!);
  expect(header("src/a.ts").getByText("@acme/web @bob")).toBeTruthy();
  expect(header("src/a.ts").getByText("· yours")).toBeTruthy();
  expect(header("src/b.ts").getByText("@carol")).toBeTruthy();
  expect(header("src/b.ts").queryByText("· yours")).toBeNull();
  expect(header("src/c.ts").queryByText(/Owned by/)).toBeNull();
});

test("with Code owners off, the review doesn't read CODEOWNERS and shows no owners, and turning it off takes them away", async () => {
  const { defaultKnobs } = await import("../lib/knobs");
  const { defaultPreferences } = await import("../lib/review-preferences");
  const { renderReview } = await import("./settings-off.test-support");
  const off = { ...defaultKnobs, codeOwners: false };
  const getCodeOwners = vi.fn(() => ({ files: [{ file: "src/a.ts", owners: ["@acme/parsers"], mine: true }] }));
  const closed = await renderReview(off, { getCodeOwners });
  fireEvent.click(await closed.main().findByRole("button", { name: "Start reading: Parsing" }));
  await waitFor(() => expect(closed.page.container.querySelector('[data-file="src/a.ts"]')).toBeTruthy());
  expect(closed.page.queryByText(/Owned by/)).toBeNull();
  expect(getCodeOwners).not.toHaveBeenCalled();
  closed.page.lifecycle.unmount(); closed.bar.lifecycle.unmount();
  // The next review opens on its Overview again.
  localStorage.clear(); sessionStorage.clear();

  let knobs = defaultKnobs;
  const open = await renderReview(defaultKnobs, { getCodeOwners, getPreferences: () => ({ preferences: { ...defaultPreferences, knobs }, revision: 1 }) });
  fireEvent.click(await open.main().findByRole("button", { name: "Start reading: Parsing" }));
  expect(await open.page.findByText(/Owned by/)).toBeTruthy();
  knobs = off;
  await open.page.emitRealtime("preferences", {});
  await waitFor(() => expect(open.page.queryByText(/Owned by/)).toBeNull());
  open.page.lifecycle.unmount(); open.bar.lifecycle.unmount();
});
