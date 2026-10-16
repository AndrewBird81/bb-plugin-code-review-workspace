// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PersistentResponsiveDrawerShell } from "./responsive-overlay";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** A window that does or doesn't ask for reduced motion. */
function motion(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)", media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }) as MediaQueryList);
}

test("a drawer slides in, except under reduced motion, where it opens in place", () => {
  const drawer = () => render(<PersistentResponsiveDrawerShell open onOpenChange={() => {}} srLabel="Review actions"><button>Archive</button></PersistentResponsiveDrawerShell>);
  motion(false);
  drawer();
  expect(screen.getByRole("dialog", { name: "Review actions" }).style.transition).toMatch(/^transform 220ms /);
  cleanup(); vi.restoreAllMocks();
  motion(true);
  drawer();
  expect(screen.getByRole("dialog", { name: "Review actions" }).style.transition).toMatch(/^transform 0ms /);
});
