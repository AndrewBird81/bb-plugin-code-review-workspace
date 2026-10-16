// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { CompactViewportOverrideProvider } from "./ui/hooks/use-compact-viewport";

afterEach(cleanup);

test("the shortcuts sheet sizes to its list, not to a page rule for <body>'s children, and scrolls past 85% of the screen", () => {
  render(<ShortcutsHelp open onOpenChange={() => {}} />);
  const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  // Portaled straight into <body>.
  expect(dialog.parentElement).toBe(document.body);
  expect(dialog.className.split(" ")).toEqual(expect.arrayContaining(["h-auto", "max-h-[85dvh]", "overflow-y-auto"]));
});

test("on a phone the shortcuts sheet is as tall as its list", async () => {
  render(<CompactViewportOverrideProvider isCompactViewport><ShortcutsHelp open onOpenChange={() => {}} /></CompactViewportOverrideProvider>);
  const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  expect(sheet.parentElement).toBe(document.body);
  expect(sheet.className.split(" ")).toContain("h-auto");
});

test("the shortcuts are grouped by what they're for, with Shift and Esc written as such", () => {
  render(<ShortcutsHelp open onOpenChange={() => {}} />);
  const dialog = within(screen.getByRole("dialog", { name: "Keyboard shortcuts" }));
  expect(dialog.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Move", "Mark", "Panels", "View"]);
  const row = (group: string, label: string) => within(dialog.getByRole("region", { name: group })).getByText(label).closest("div")!.querySelector("dt")!.textContent;
  expect(row("Mark", "Mark the chapter viewed")).toBe("⇧V");
  expect(row("Panels", "Show or hide the chapters")).toBe("t");
  expect(row("Panels", "Show or hide Comments")).toBe("c");
  expect(row("Panels", "Finish review")).toBe("s");
  expect(row("Panels", "Close what's over the code, or leave full screen")).toBe("Esc");
  expect(row("View", "Fold or unfold comments in code")).toBe("i");
  expect(row("View", "Full screen on or off")).toBe("⇧F");
  expect(row("View", "Since your review or All changes, on a re-review")).toBe("d");
});

test("its ✕ keeps its size but has a 44px target on a touch screen, an iPad's included", () => {
  render(<ShortcutsHelp open onOpenChange={() => {}} />);
  const close = within(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).getByRole("button", { name: "Close" });
  expect(close.className.split(" ")).toEqual(expect.arrayContaining(["pointer-coarse:after:h-11", "pointer-coarse:after:min-w-11"]));
});
