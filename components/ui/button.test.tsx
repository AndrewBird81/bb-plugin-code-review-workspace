// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Button } from "./button";

afterEach(cleanup);

test("a focused button shows a 2px ring, set off from it by 1px of the background, in every variant", () => {
  for (const variant of ["default", "outline", "ghost", "link"] as const) {
    render(<Button variant={variant}>Save</Button>);
    const classes = screen.getByRole("button", { name: "Save" }).className.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["focus-visible:ring-2", "focus-visible:ring-ring", "focus-visible:ring-offset-1", "focus-visible:ring-offset-background"]));
    expect(classes).not.toContain("focus-visible:ring-1");
    cleanup();
  }
});
