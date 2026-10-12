// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Hint } from "./hint";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test("a hint opens for the keyboard's focus, and not for focus that isn't :focus-visible, as a script gives it after a tap", async () => {
  // jsdom matches :focus-visible on any focus; a browser doesn't when the last input was a pointer.
  let keyboard = false;
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
    return selector === ":focus-visible" ? keyboard && this === document.activeElement : matches.call(this, selector);
  });
  render(<Hint label="Comments (c)"><button>Comments</button></Hint>);
  const button = screen.getByRole("button", { name: "Comments" });
  act(() => button.focus());
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => button.blur());
  keyboard = true;
  act(() => button.focus());
  expect((await screen.findByRole("tooltip")).textContent).toBe("Comments (c)");
  // A pointer still opens it by hovering.
  act(() => button.blur());
  keyboard = false;
  fireEvent.pointerMove(button, { pointerType: "mouse" });
  expect((await screen.findByRole("tooltip")).textContent).toBe("Comments (c)");
});
