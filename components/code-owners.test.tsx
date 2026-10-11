// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
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
