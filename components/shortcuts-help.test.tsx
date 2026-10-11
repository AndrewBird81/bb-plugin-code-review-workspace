// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ShortcutsHelp } from "./ShortcutsHelp";

afterEach(cleanup);

test("the shortcuts sheet sizes to its list, not to a page rule for <body>'s children, and scrolls past 85% of the screen", () => {
  render(<ShortcutsHelp open onOpenChange={() => {}} />);
  const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  // Portaled straight into <body>.
  expect(dialog.parentElement).toBe(document.body);
  expect(dialog.className.split(" ")).toEqual(expect.arrayContaining(["h-auto", "max-h-[85dvh]", "overflow-y-auto"]));
});
