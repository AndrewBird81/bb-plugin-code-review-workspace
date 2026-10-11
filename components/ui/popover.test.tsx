// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CompactViewportOverrideProvider } from "./hooks/use-compact-viewport";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

afterEach(cleanup);

test("on a phone a menu's sheet is as tall as its content and its content as wide as the sheet", async () => {
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <Popover open onOpenChange={() => {}}>
        <PopoverTrigger>More</PopoverTrigger>
        <PopoverContent mobileTitle="Review actions" className="w-60 max-w-[calc(100vw-24px)] p-1"><button>Archive</button></PopoverContent>
      </Popover>
    </CompactViewportOverrideProvider>,
  );
  const sheet = await screen.findByRole("dialog", { name: "Review actions" });
  // Portaled straight into <body>, where a page rule for its children mustn't stretch it.
  expect(sheet.parentElement).toBe(document.body);
  expect(sheet.className.split(" ")).toEqual(expect.arrayContaining(["h-auto", "max-h-[92dvh]"]));
  const content = (await screen.findByRole("button", { name: "Archive" })).parentElement!.className.split(" ");
  expect(content).not.toContain("w-60");
  expect(content).toEqual(expect.arrayContaining(["w-auto", "max-w-none", "p-1"]));
});
