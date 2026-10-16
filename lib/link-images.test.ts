import { expect, test } from "vitest";
import { linkImages } from "./link-images";

test("an inline image becomes a link to it, named by its alt text", () => {
  expect(linkImages("See ![the chart](https://attacker.example/t.png) here.")).toBe("See [Image: the chart](https://attacker.example/t.png) here.");
  expect(linkImages("![](https://attacker.example/t.png)")).toBe("[Image](https://attacker.example/t.png)");
  expect(linkImages('![x](<https://a.example/a b.png> "Title")')).toBe('[Image: x](<https://a.example/a b.png> "Title")');
  expect(linkImages("![x](https://a.example/a_(1).png)")).toBe("[Image: x](https://a.example/a_(1).png)");
});

test("a reference image becomes a reference link, keeping its definition", () => {
  const defs = "\n\n[logo]: https://attacker.example/logo.png";
  expect(linkImages(`![Logo][logo]${defs}`)).toBe(`[Image: Logo][logo]${defs}`);
  expect(linkImages(`![logo][]${defs}`)).toBe(`[Image: logo][logo]${defs}`);
  expect(linkImages(`A ![logo] B${defs}`)).toBe(`A [Image: logo][logo] B${defs}`);
  // Without a definition, it was never an image.
  expect(linkImages("A ![logo] B")).toBe("A ![logo] B");
});

test("an HTML image becomes a link to its src, or its srcset's first url", () => {
  expect(linkImages('Look: <img width="20" src="https://attacker.example/p.gif?a=1&amp;b=2" alt="pixel">')).toBe("Look: [Image: pixel](https://attacker.example/p.gif?a=1&b=2)");
  expect(linkImages("<IMG SRC='https://a.example/x.png'/>")).toBe("[Image](https://a.example/x.png)");
  expect(linkImages('<img srcset="https://a.example/x2.png 2x, https://a.example/x.png 1x">')).toBe("[Image](https://a.example/x2.png)");
  expect(linkImages('<img alt="nothing">')).toBe("Image: nothing");
});

test("an image inside a link's text, as a badge, becomes its words, the link kept", () => {
  expect(linkImages("[![CI](https://img.example/ci.svg)](https://ci.example/run)")).toBe("[Image: CI](https://ci.example/run)");
});

test("code spans and fences are left as written", () => {
  expect(linkImages("Write `![x](y.png)` for an image, or ``![a](b) `c` ``.")).toBe("Write `![x](y.png)` for an image, or ``![a](b) `c` ``.");
  const fenced = "Before ![a](a.png)\n```md\n![x](y.png)\n<img src=\"z.png\">\n```\n~~~\n![t](t.png)\n~~~\nAfter ![b](b.png)";
  expect(linkImages(fenced)).toBe("Before [Image: a](a.png)\n```md\n![x](y.png)\n<img src=\"z.png\">\n```\n~~~\n![t](t.png)\n~~~\nAfter [Image: b](b.png)");
  // A fence left open runs to the end.
  expect(linkImages("```\n![x](y.png)")).toBe("```\n![x](y.png)");
});

test("text with no image, an escaped one, or a plain link is unchanged", () => {
  for (const text of ["Plain words.", "[a link](https://a.example)", "\\![not](an image)", "Ends with !", ""]) expect(linkImages(text)).toBe(text);
});
