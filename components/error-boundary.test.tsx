// @vitest-environment jsdom
import type { ComponentType } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";

// Needs review's rows, failing to draw.
vi.mock("./NeedsReviewSidebar", () => ({ NeedsReviewSidebar: () => { throw new Error("Couldn't draw the rows"); } }));

afterEach(cleanup);

test("Needs review's rows failing to draw leave BB's thread list as it is, rather than take it down", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const app = await loadPluginApp(() => import("../app"));
  const Overlay = app.appOverlays.find((registration) => registration.id === "needs-review")!.component as ComponentType;
  const { container } = render(<div><Overlay /><p>BB's thread list</p></div>);
  expect(container.textContent).toBe("BB's thread list");
  report.mockRestore();
});
