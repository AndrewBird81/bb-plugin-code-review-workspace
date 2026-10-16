// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import { Icon, type IconName } from "./icon";
import { ICON_DATA } from "./icon-data";

afterEach(cleanup);

test("every icon draws an svg of its paths, 24 px square with Hugeicons' 1.5 stroke", () => {
  const names = Object.keys(ICON_DATA) as IconName[];
  expect(names.length).toBeGreaterThan(70);
  for (const name of names) {
    const svg = render(<Icon name={name} className="size-4" aria-hidden />).container.querySelector("svg")!;
    expect(svg, name).toBeTruthy();
    expect([svg.getAttribute("width"), svg.getAttribute("height"), svg.getAttribute("viewBox"), svg.getAttribute("fill")]).toEqual(["24", "24", "0 0 24 24", "none"]);
    expect([svg.getAttribute("class"), svg.getAttribute("aria-hidden"), svg.dataset.icon]).toEqual(["size-4", "true", name]);
    const shapes = Array.from(svg.children);
    expect(shapes.length, name).toBeGreaterThan(0);
    for (const shape of shapes) {
      expect(["path", "circle"]).toContain(shape.tagName);
      expect([shape.getAttribute("stroke"), shape.getAttribute("stroke-width")]).toEqual(["currentColor", "1.5"]);
    }
    cleanup();
  }
});

test("an icon with a label is named by it", () => {
  const svg = render(<Icon name="Github" aria-label="GitHub" />).container.querySelector("svg")!;
  expect([svg.getAttribute("aria-label"), svg.getAttribute("aria-hidden"), svg.getAttribute("class")]).toEqual(["GitHub", null, ""]);
});

test("the plugin installs no icon package: its icons are in icon-data.ts", () => {
  const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync("package.json", "utf8"));
  expect(Object.keys({ ...dependencies, ...devDependencies }).filter((name) => name.startsWith("@hugeicons/"))).toEqual([]);
});
