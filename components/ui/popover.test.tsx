// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CompactViewportOverrideProvider } from "./hooks/use-compact-viewport";
import { Popover, PopoverContent, PopoverTrigger, foldBand, foldPadding } from "./popover";

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

test("a menu's sheet keeps its end clear of the home indicator whatever padding the menu asks for, and the popover keeps it", async () => {
  const menu = (compact: boolean) => render(
    <CompactViewportOverrideProvider isCompactViewport={compact}>
      <Popover open onOpenChange={() => {}}>
        <PopoverTrigger>More</PopoverTrigger>
        <PopoverContent mobileTitle="Review actions" className="w-64 p-1"><button>Delete…</button></PopoverContent>
      </Popover>
    </CompactViewportOverrideProvider>,
  );
  menu(true);
  const sheet = (await screen.findByRole("button", { name: "Delete…" })).parentElement!.className.split(" ");
  expect(sheet).toEqual(expect.arrayContaining(["p-1", "pb-[max(1rem,env(safe-area-inset-bottom))]"]));
  cleanup();
  menu(false);
  const popover = (await screen.findByRole("button", { name: "Delete…" })).parentElement!.className.split(" ");
  expect(popover).toContain("p-1");
  expect(popover.some((name) => name.startsWith("pb-"))).toBe(false);
});

test("a menu's sheet keeps its content clear of each side's safe area, the Duo's rail or a notch held sideways, whatever padding it asks for", async () => {
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <Popover open onOpenChange={() => {}}>
        <PopoverTrigger>More</PopoverTrigger>
        <PopoverContent mobileTitle="Review actions" className="w-64 p-1"><button>Archive</button></PopoverContent>
      </Popover>
    </CompactViewportOverrideProvider>,
  );
  const sheet = (await screen.findByRole("dialog", { name: "Review actions" })).className.split(" ");
  expect(sheet).toEqual(expect.arrayContaining(["pl-[env(safe-area-inset-left)]", "pr-[env(safe-area-inset-right)]", "inset-x-0"]));
});

const restores: (() => void)[] = [];
const cleanupWindow = () => restores.splice(0).forEach((restore) => restore());
afterEach(cleanupWindow);

/** A window `width` × `height`, touched or not, in Safari or a home-screen app (`standalone`), with the fold the browser reports, if any. */
function fakeWindow(width: number, height: number, { coarse = true, standalone = false, segments }: { coarse?: boolean; standalone?: boolean; segments?: DOMRect[] } = {}) {
  const root = document.documentElement;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(root, "clientHeight", { configurable: true, get: () => height });
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(pointer: coarse)" ? coarse : query === "(display-mode: standalone)" ? standalone : false,
    media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }) as MediaQueryList);
  if (segments) (window as { viewport?: unknown }).viewport = { segments };
  restores.push(() => {
    delete (root as { clientWidth?: number }).clientWidth;
    delete (root as { clientHeight?: number }).clientHeight;
    matchMedia.mockRestore();
    delete (window as { viewport?: unknown }).viewport;
  });
}

test("upright on the Duo's inner screen, menus keep out of the fold: 40% to 52% down the window in Safari, its middle in a home-screen app; nowhere else", () => {
  // Safari on the unfolded Duo held upright: 669 × 869.
  fakeWindow(669, 869);
  expect(foldBand()).toEqual({ top: 348, bottom: 452 });
  cleanupWindow();
  // Held sideways the fold runs down the screen, which menus from the top don't reach across.
  fakeWindow(951, 589);
  expect(foldBand()).toBeNull();
  cleanupWindow();
  // A home-screen app upright: its window is the screen, whose middle the fold is (y 455–496), 24px either side.
  fakeWindow(669, 951, { standalone: true });
  expect(foldBand()).toEqual({ top: 452, bottom: 500 });
  cleanupWindow();
  // The iPad upright, and a desktop's window, have no fold.
  fakeWindow(1032, 1376);
  expect(foldBand()).toBeNull();
  cleanupWindow();
  fakeWindow(669, 869, { coarse: false });
  expect(foldBand()).toBeNull();
  cleanupWindow();
  // Where the browser reports the fold, 8px either side of it, in a home-screen app too; side by side, as without one.
  fakeWindow(669, 951, { standalone: true, segments: [new DOMRect(0, 0, 669, 455), new DOMRect(0, 496, 669, 455)] });
  expect(foldBand()).toEqual({ top: 447, bottom: 504 });
  cleanupWindow();
  fakeWindow(951, 669, { segments: [new DOMRect(0, 0, 455, 669), new DOMRect(496, 0, 455, 669)] });
  expect(foldBand()).toBeNull();
});

test("a menu keeps to the part of the window its trigger is in: above the fold from nearer the top, else below it", () => {
  const band = { top: 348, bottom: 452 };
  // The title bar's ⋯, and a row's ⋯ just above the band: their menus end above it, under or over the trigger.
  expect(foldPadding({ top: 0, bottom: 44 }, band, 869)).toEqual({ bottom: 521 });
  expect(foldPadding({ top: 352, bottom: 396 }, band, 869)).toEqual({ bottom: 521 });
  // A row's ⋯ lower down: its menu starts below the band, rather than opening over it from under the trigger.
  expect(foldPadding({ top: 390, bottom: 434 }, band, 869)).toEqual({ top: 452 });
  expect(foldPadding({ top: 604, bottom: 648 }, band, 869)).toEqual({ top: 452 });
});

test("with a fold to keep out of, a popover scrolls what doesn't fit; without one it doesn't", async () => {
  fakeWindow(669, 869);
  const menu = () => render(
    <Popover open onOpenChange={() => {}}>
      <PopoverTrigger>More</PopoverTrigger>
      <PopoverContent className="w-64 p-1"><button>Delete…</button></PopoverContent>
    </Popover>,
  );
  menu();
  // Radix's room for it, short of the fold, which its collision padding gives.
  const capped = (await screen.findByRole("button", { name: "Delete…" })).parentElement!;
  expect([capped.style.maxHeight, capped.style.overflowY]).toEqual(["var(--radix-popover-content-available-height)", "auto"]);
  cleanup();
  cleanupWindow();
  fakeWindow(1032, 1376);
  menu();
  expect((await screen.findByRole("button", { name: "Delete…" })).parentElement!.style.maxHeight).toBe("");
});
