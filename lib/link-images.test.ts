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
  // Without a definition it was never an image, and shows as it did.
  expect(linkImages("A ![logo] B")).toBe("A \\![logo] B");
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

test("an image written inside a fence shows as a link too", () => {
  const fenced = "Before ![a](a.png)\n```md\n![x](y.png)\n<img src=\"z.png\">\n```\n~~~\n![t](t.png)\n~~~\nAfter ![b](b.png)";
  expect(linkImages(fenced)).toBe("Before [Image: a](a.png)\n```md\n[Image: x](y.png)\n[Image](z.png)\n```\n~~~\n[Image: t](t.png)\n~~~\nAfter [Image: b](b.png)");
});

// In an HTML block a fence line is raw HTML, so the image after the block was a paragraph while linkImages skipped it
// as fenced (95-recheck P2 #1).
test("a fence line inside an HTML block doesn't keep the image after the block", () => {
  for (const [open, close] of [["<!--", "-->"], ["<pre>", "</pre>"], ["<script>", "</script>"], ["<?", "?>"], ["<div>", "</div>\n"]]) {
    expect(linkImages(`${open}\n\`\`\`\n${close}\n![x](https://evil.test/h.png)\n\`\`\``)).toBe(`${open}\n\`\`\`\n${close}\n[Image: x](https://evil.test/h.png)\n\`\`\``);
  }
  expect(linkImages("<div>\n```\n</div>\n\n<img src=\"https://evil.test/d.png\">\n```")).toBe("<div>\n```\n</div>\n\n[Image](https://evil.test/d.png)\n```");
});

// Each of these rendered an image after linkImages (70-review #1, 71-security F2).
test("code spans, open or indented fences, and definitions in a quote or list don't keep an image", () => {
  // A code span can't cross a blank line, and backticks in an autolink or a tag start none.
  expect(linkImages("`x\n\n![p](https://evil.example/a.png)\n\n`")).toBe("`x\n\n[Image: p](https://evil.example/a.png)\n\n`");
  expect(linkImages("<https://a.test/`> ![x](https://evil.test/al.png) <https://b.test/`>")).toBe("<https://a.test/`> [Image: x](https://evil.test/al.png) <https://b.test/`>");
  expect(linkImages("Write `![x](y.png)` for an image.")).toBe("Write `[Image: x](y.png)` for an image.");
  // A fence in a list item ends with the item; one never closed may be cut where it's shown.
  expect(linkImages("- item\n  ```\n![p](https://evil.example/b.png)")).toBe("- item\n  ```\n[Image: p](https://evil.example/b.png)");
  expect(linkImages("1. item\n   ```\nend\n![x](https://evil.test/lf.png)\n```")).toBe("1. item\n   ```\nend\n[Image: x](https://evil.test/lf.png)\n```");
  expect(linkImages("```\n![x](y.png)")).toBe("```\n[Image: x](y.png)");
  // A definition this can't see: the image keeps its words, as a link at most.
  expect(linkImages("![r]\n\n> [r]: https://evil.test/bq.png")).toBe("\\![r]\n\n> [r]: https://evil.test/bq.png");
  expect(linkImages("![a\\]b]\n\n[a\\]b]: https://evil.test/esc.png")).toBe("\\![a\\]b]\n\n[a\\]b]: https://evil.test/esc.png");
  expect(linkImages("![a `]` b](https://evil.test/c.png)")).toBe("\\![a `]` b](https://evil.test/c.png)");
});

test("a link after a `!` doesn't make a new image", () => {
  expect(linkImages("!![x](https://evil.test/a.png)")).toBe("\\![Image: x](https://evil.test/a.png)");
  expect(linkImages("!<img src=https://evil.test/b.png>")).toBe("\\![Image](https://evil.test/b.png)");
  expect(linkImages("\\!![x](a.png)")).toBe("\\![Image: x](a.png)");
});

test("text with no image, an escaped one, or a plain link is unchanged", () => {
  for (const text of ["Plain words.", "[a link](https://a.example)", "\\![not](an image)", "Ends with !", ""]) expect(linkImages(text)).toBe(text);
});
