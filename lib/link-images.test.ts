import { expect, test } from "vitest";
import type { Nodes } from "mdast";
import { codeRanges, linkImages, resolveLinks } from "./link-images";
import { parseMarkdown } from "./markdown-blocks";

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

// BB's HTML renders <video src poster> and <source src srcset>, which loaded from wherever they pointed (95-recheck P2 #2).
test("an HTML video or source becomes links to what it would load", () => {
  expect(linkImages('<video poster="https://evil.test/p.png"></video>')).toBe("[Video poster](https://evil.test/p.png)&lt;/video>");
  expect(linkImages("<VIDEO controls src=https://evil.test/v.mp4 poster='https://evil.test/p.png' title=\"Demo\">")).toBe("[Video: Demo](https://evil.test/v.mp4) [Poster](https://evil.test/p.png)");
  expect(linkImages('<video controls>\n<source src="https://evil.test/v.webm" type="video/webm">\n</video>')).toBe("Video\n[Media](https://evil.test/v.webm)\n&lt;/video>");
  expect(linkImages('<picture><source srcset="https://evil.test/a.avif 1x, https://evil.test/b.avif 2x"><img src="https://evil.test/c.png" alt="c"></picture>')).toBe("&lt;picture>[Media](https://evil.test/a.avif)[Image: c](https://evil.test/c.png)&lt;/picture>");
  expect(linkImages('<source type="video/mp4">')).toBe("");
});

test("an image inside a link's text, as a badge, becomes its words, the link kept", () => {
  expect(linkImages("[![CI](https://img.example/ci.svg)](https://ci.example/run)")).toBe("[Image: CI](https://ci.example/run)");
});

// Naming each tag that loads something missed one every round (audit S15, 95-recheck, 96-recheck-2), so only tags
// that format are left as HTML.
test("HTML outside code shows as text, but for tags that only format", () => {
  expect(linkImages('<iframe src="https://evil.test/f"></iframe>')).toBe('&lt;iframe src="https://evil.test/f">&lt;/iframe>');
  expect(linkImages("<SVG><IMAGE HREF=x.png /></SVG>")).toBe("&lt;SVG>&lt;IMAGE HREF=x.png />&lt;/SVG>");
  expect(linkImages("<?php ?> <![CDATA[x]]> <!DOCTYPE html> </span>")).toBe("&lt;?php ?> &lt;\\![CDATA[x]]> &lt;!DOCTYPE html> &lt;/span>");
  // A tag it keeps may have only the attributes it lists, with plain values.
  expect(linkImages('<p style="background:url(https://evil.test/s.png)">x</p>')).toBe('&lt;p style="background:url(https://evil.test/s.png)">x</p>');
  expect(linkImages('<table background="https://evil.test/t.png">')).toBe('&lt;table background="https://evil.test/t.png">');
  expect(linkImages('<details ontoggle="x" open>')).toBe('&lt;details ontoggle="x" open>');
  expect(linkImages(`<p align='a"b'>`)).toBe(`&lt;p align='a"b'>`);
  // Autolinks stay links.
  expect(linkImages("<https://a.example/x> and <me@a.example>")).toBe("<https://a.example/x> and <me@a.example>");
});

// Escaping <!-- showed PR templates' and bots' hidden notes as text, where GitHub and 0.7.0 hid them (96-fixes-4 §3).
test("HTML comments are hidden, and what their removal joins shows as text", () => {
  expect(linkImages("<!-- Describe your change -->\nFixes the parser.<!-- bot:marker -->")).toBe("\nFixes the parser.");
  expect(linkImages("a<!--\nhidden\n\nlines\n-->b <!--> c <!---> d")).toBe("ab  c  d");
  expect(linkImages('<im<!-- -->g src="https://evil.test/x.png">')).toBe('&lt;img src="https://evil.test/x.png">');
  expect(linkImages('<<!-- -->img src="https://evil.test/x.png">')).toBe('&lt;img src="https://evil.test/x.png">');
  expect(linkImages("!<!-- -->[x](https://evil.test/x.png)")).toBe("\\![x](https://evil.test/x.png)");
  // Unclosed, or in code, it shows as written.
  expect(linkImages("<!-- unclosed <b>x</b>")).toBe("&lt;!-- unclosed <b>x</b>");
  expect(linkImages("Use `<!-- x -->` here.\n\n```html\n<!-- kept -->\n```")).toBe("Use `<!-- x -->` here.\n\n```html\n<!-- kept -->\n```");
});

// Each of these left a tag that loads once the rewrite or the escaping joined what was around it (96-recheck-2 P2 #1, #2).
test("escaping can't make a tag of what's around it", () => {
  expect(linkImages('<vi<source>deo poster="https://evil.test/p.png"></video>')).toBe('&lt;video poster="https://evil.test/p.png">&lt;/video>');
  expect(linkImages('<im<source>g src="https://evil.test/i.png">')).toBe('&lt;img src="https://evil.test/i.png">');
  expect(linkImages('<<img> src="https://evil.test/x.png">')).toBe('&lt;Image src="https://evil.test/x.png">');
  expect(linkImages('[<![](u) src="https://evil.test/y.png">](https://z.test)')).toBe('[&lt;Image src="https://evil.test/y.png">](https://z.test)');
});

test("formatting HTML, code spans and fences stay as written", () => {
  for (const text of [
    "<details open>\n<summary>Logs</summary>\n\n```\nerror <foo>\n```\n\n</details>\n\nAfter `T<U>`.",
    '<p align="center"><b>Bold</b><br/><kbd>Ctrl</kbd> <sub>x</sub></p>\n\n<table><tr><td align=left>a</td></tr></table>',
    "This returns `Array<string>`, not `![x]`.\n\n```ts\nconst xs: Array<string> = [];\nif (![\"a\"].includes(kind)) return <img src={logo} />;\n```",
    "- One `a<b>`\n- Two:\n  ```tsx\n  <img src={logo} alt=\"Logo\" />\n  ```\n\n> ```\n> <video poster={p} /> ![x](y)\n> ```\n\n~~~\n<script>![a](b)</script>\n~~~",
    "See [the docs](https://a.example/docs) for `Map<K, V>`.\n\n```\nunclosed <img src=x>",
    // BB reads no single $ as math (96-recheck-3 P3).
    "Costs $5, and `Array<string>` is fine.",
  ]) expect(linkImages(text)).toBe(text);
  const shown = new DOMParser().parseFromString(linkImages("<details>\n<summary>More</summary>\n\nText\n\n</details>"), "text/html");
  expect(shown.querySelector("details > summary")?.textContent).toBe("More");
});

// In an HTML block a fence line is raw HTML, so the fence's lines weren't code (95-recheck P2 #1); the block ends where
// CommonMark ends it, so what comes after is read as it shows.
test("a fence that an HTML block makes raw HTML is changed like the rest", () => {
  expect(linkImages('<details>\n```\n<img src="https://evil.test/f.png">\n```\n\n</details>')).toBe("<details>\n```\n[Image](https://evil.test/f.png)\n```\n\n</details>");
  expect(linkImages('<b>\n```\n<img src="https://evil.test/b.png">\n```')).toBe("<b>\n```\n[Image](https://evil.test/b.png)\n```");
  expect(linkImages("<pre>\n```\n</pre>\n![x](https://evil.test/h.png)\n```")).toBe("<pre>\n```\n</pre>\n[Image: x](https://evil.test/h.png)\n```");
  expect(linkImages("<div>\n```\n</div>\n\n<img src=\"https://evil.test/d.png\">\n```")).toBe("<div>\n```\n</div>\n\n[Image](https://evil.test/d.png)\n```");
  // A tag it escapes begins no HTML block, so the fence after it is code.
  for (const open of ["<!--", "<script>", "<?", "<span>"]) {
    expect(linkImages(`${open}\n\`\`\`\n![x](https://evil.test/h.png)\n\`\`\``)).toBe(`&lt;${open.slice(1)}\n\`\`\`\n![x](https://evil.test/h.png)\n\`\`\``);
  }
});

// Each of these rendered an image after linkImages (70-review #1, 71-security F2), or would once a span was kept.
test("code spans it can't be sure of, and what follows a doubtful fence, are changed like the rest", () => {
  // A code span can't cross a blank line, and backticks in an autolink or a tag start none.
  expect(linkImages("`x\n\n![p](https://evil.example/a.png)\n\n`")).toBe("`x\n\n[Image: p](https://evil.example/a.png)\n\n`");
  expect(linkImages("<https://a.test/`> ![x](https://evil.test/al.png) <https://b.test/`>")).toBe("&lt;https://a.test/`> [Image: x](https://evil.test/al.png) &lt;https://b.test/`>");
  // A table's cells, a link's destination and an autolink literal can each take a backtick from a code span.
  expect(linkImages('| a | b |\n|---|---|\n| ` | `<img src="https://evil.test/t.png">` |')).toBe("| a | b |\n|---|---|\n| ` | `[Image](https://evil.test/t.png)` |");
  expect(linkImages('| a |\n|---|\n| `x | <img src="https://evil.test/t2.png"> | y` |')).toBe("| a |\n|---|\n| `x | [Image](https://evil.test/t2.png) | y` |");
  expect(linkImages('| a |\n|---|\n| `x \\\\| <img src="https://evil.test/t3.png"> | y` |')).toBe("| a |\n|---|\n| `x \\\\| [Image](https://evil.test/t3.png) | y` |");
  expect(linkImages('See [x](u`) <img src="https://evil.test/r.png"> `y`')).toBe("See [x](u`) [Image](https://evil.test/r.png) `y`");
  expect(linkImages('https://a.test/` `a`<img src="https://evil.test/l.png">`')).toBe("https://a.test/` `a`[Image](https://evil.test/l.png)`");
  // Inline math, as $$ begins it, can hold a backtick.
  expect(linkImages('$$ ` $$ `<img src="https://evil.test/mt.png">`')).toBe("$$ ` $$ `[Image](https://evil.test/mt.png)`");
  // A table of one column needs no pipe (96-fixes-4).
  expect(linkImages('a\n:-:\n`<img src="https://evil.test/t1.png"> | y`')).toBe("a\n:-:\n`[Image](https://evil.test/t1.png) | y`");
  // A fence in a list item ends with the item.
  expect(linkImages("- item\n  ```\n![p](https://evil.example/b.png)")).toBe("- item\n  ```\n[Image: p](https://evil.example/b.png)");
  expect(linkImages("1. item\n   ```\nend\n![x](https://evil.test/lf.png)\n```")).toBe("1. item\n   ```\nend\n[Image: x](https://evil.test/lf.png)\n```");
  // Math, a directive, a definition's title and a tab in a list item can each hide where a fence is.
  for (const before of ["$$\n```\n$$", ":::note\n```\n:::", '[a]: u "\n```\n"', "- a\n \t```\nx\n```"]) {
    expect(linkImages(`${before}\n<img src="https://evil.test/m.png">\n\`\`\``)).toBe(`${before}\n[Image](https://evil.test/m.png)\n\`\`\``);
  }
  // A definition this can't see: the image keeps its words, as a link at most.
  expect(linkImages("![r]\n\n> [r]: https://evil.test/bq.png")).toBe("\\![r]\n\n> [r]: https://evil.test/bq.png");
  expect(linkImages("![a\\]b]\n\n[a\\]b]: https://evil.test/esc.png")).toBe("\\![a\\]b]\n\n[a\\]b]: https://evil.test/esc.png");
  expect(linkImages("![a `]` b](https://evil.test/c.png)")).toBe("\\![a `]` b](https://evil.test/c.png)");
});

// BB read each of these as raw HTML where linkImages read a paragraph, so the code span or `\<` loaded (96-recheck-3 P2):
// `<pre/>` begins CommonMark's 7th HTML block, which runs to a blank line, and a footnote definition is a container.
test("a code span or \\< that BB reads as raw HTML loads nothing", () => {
  const media = ['`<img src="https://evil.test/x.png">`', '\\<Image src="https://evil.test/x.png">', '`<video poster="https://evil.test/x.png">`'];
  for (const [first, next] of [["", ""], ["> ", "> "], ["- ", "  "], ["01. ", "    "]]) {
    for (const payload of media) {
      expect(linkImages(`${first}<pre/>\n${next}</pre>\n${next}${payload}`)).not.toMatch(/<(?:img|image|video)/i);
    }
  }
  for (const tag of ["<b>", "<pre>", "</pre>", "<div>", "<details>", "<summary>x</summary>", "<br/>", '<p align="center">', "<hr>", "<code>", "<td>"]) {
    expect(linkImages(`x[^1]\n\n[^1]: ${tag}\n    \\<Image src="https://evil.test/x.png">`)).not.toMatch(/<(?:img|image|video)/i);
  }
  expect(linkImages("| a | b |\n[^1]: <pre/>\n\\<Image src=x>")).not.toMatch(/<image/i);
  // On a paragraph's line `\<` shows as `<` either way.
  expect(linkImages("a \\<b> c")).toBe("a &lt;b> c");
});

// A footnote reference defined later takes its label's backtick before a code span can, so BB read the tag after it as
// raw HTML where linkImages kept it as code (96-recheck-4).
test("a backtick in a footnote reference's label pairs with nothing", () => {
  const img = '<img src="https://evil.test/x.png">';
  expect(linkImages(`x [^\`] ${img} \`\n\n[^\`]: n`)).toBe("x [^`] [Image](https://evil.test/x.png) `\n\n[^`]: n");
  for (const text of [
    `x [^\`] ${img} \`\n\n> [^\`]: n`,
    `x [^\`] ${img} \`\n\n- [^\`]: n`,
    `x [^\`\`] ${img} \`\`\n\n[^\`\`]: n`,
    `| a |\n|---|\n| [^\`] ${img} \` |\n\n[^\`]: n`,
    `# [^\`] ${img} \`\n\n[^\`]: n`,
    `x [^a\\]\`] ${img} \`\n\n[^a\\]\`]: n`,
  ]) expect(linkImages(text)).not.toMatch(/<img/);
  // A label without one takes none.
  expect(linkImages("See [^1] and `<img src={logo} />`.\n\n[^1]: n")).toBe("See [^1] and `<img src={logo} />`.\n\n[^1]: n");
});

// Each `[^` tested the rest of its line for a backtick, so a line of them was quadratic: 60 KB took 5 s (bug bash SEC-3).
test("a long line of footnote openers is read in linear time", () => {
  const started = performance.now();
  linkImages("<b>[^".repeat(12_000));
  expect(performance.now() - started).toBeLessThan(250);
}, 60_000);

// An ordered item can interrupt a paragraph only from 1, and an empty one none, so after "a" an "01." line goes on
// with it, and BB read the "fence" in it as text with raw HTML (96-fixes-4).
test("a list item that can't interrupt a paragraph, or indented code, begins no fence", () => {
  expect(linkImages('a\n01. b\n    ``` <img src="https://evil.test/x.png">')).toBe("a\n01. b\n    ``` [Image](https://evil.test/x.png)");
  expect(linkImages('a\n01. b\n    ```\n    <img src="https://evil.test/x.png">')).toBe("a\n01. b\n    ```\n    [Image](https://evil.test/x.png)");
  // micromark reads one after indented code the same way.
  for (const item of ["1. ", "- ", "01. x"]) {
    expect(linkImages(`    code\n${item}\n    \`\`\` <img src="https://evil.test/ic.png">`)).toBe(`    code\n${item}\n    \`\`\` [Image](https://evil.test/ic.png)`);
  }
  // From 1 it does.
  expect(linkImages("a\n1. b\n   ```\n   <img src={logo} />\n   ```")).toBe("a\n1. b\n   ```\n   <img src={logo} />\n   ```");
});

// A backtick fence's info string can't hold a backtick, but the test's `.` stopped at U+2028 and U+2029, so after one
// it read a fence where BB reads a paragraph, and kept the raw <img> below it as code (bug bash SEC-1).
for (const [name, separator] of [["U+2028", "\u2028"], ["U+2029", "\u2029"]]) {
  test(`a backtick after ${name} in a backtick fence's info string opens no fence, so the image after it stays a link`, () => {
    const url = "https://evil.test/x.png";
    expect(linkImages(`\`\`\`a${separator}\`\n<img src="${url}">\n\`\`\``)).not.toContain("<img");
    expect(linkImages(`\`\`\`a${separator}\`\n![x](${url})\n\`\`\``)).not.toContain(`![x](${url})`);
    // Blank lines between: BB reads the <img> as an HTML block of its own.
    expect(linkImages(`\`\`\`${separator}\`\n\n<img src="${url}">\n\n\`\`\``)).not.toContain("<img");
    // The opener and the x are a paragraph's lines; only the last ``` (an unclosed fence of its own) may be code.
    const text = `\`\`\`a${separator}\`\nx\n\`\`\``;
    const x = text.indexOf("\nx\n") + 1;
    expect(codeRanges(text).filter(([start, end]) => (start <= x && x < end) || end <= x)).toEqual([]);
  });
}

// A table's rows were all changed like prose, so agents' tables of types showed Array&lt;T> (96-recheck-3 P3). A span
// stays as written where it's one whether BB reads the row as cells or as a paragraph's line.
test("a code span in a table's cell stays as written", () => {
  for (const text of [
    "| Type | Note |\n|---|:-:|\n| `Array<T>` | `![` and `<img src={logo} />` |\n| `a \\| b<c>` | x |",
    "Before\n| a | `Map<K, V>` |\n| - | - |",
    "> | a |\n> |---|\n> | `Promise<void>` |",
  ]) expect(linkImages(text)).toBe(text);
});

// At the margin a tab indents to 4 columns, as CommonMark reads it, so the code after a tab-indented line showed
// changed for nothing (96-recheck-3 P3).
test("a tab at the margin indents the line 4 columns", () => {
  for (const text of ["Example:\n\n\tindented();\n\nthen `Array<string>`.", "Text\n\tgoes on `Map<K, V>`", "\t```\nx\n```\n<img src={logo} />\n```"]) {
    expect(linkImages(text)).toBe(text);
  }
  // Indented code is still changed.
  expect(linkImages('  \t<img src="https://evil.test/ti.png">')).toBe("  \t[Image](https://evil.test/ti.png)");
});

// Keeping top-level indented code as written let BB load an image the reader took for code, after a list item that
// began empty or a list start the reader refused, which BB reads as a list item's paragraph (71-review-security F1).
test("an image after an empty list item or a refused list start stays a link", () => {
  const img = '<img src="https://evil.test/x.png">';
  const docs = [
    `-\n      x\n\n    ${img}`, `*\n        x\n\n    ${img}`, `1.\n       x\n\n    ${img}`, `-\n      x\n\n\n    ${img}`, `a\n\n-\n      x\n\n    ${img}`,
    '-\n      x\n\n    <video poster="https://evil.test/x.png">', "-\n      x\n\n    ![a](https://evil.test/x.png)", `-\n      code\n    ${img}`,
    `-\n  ***\n\n    ${img}`, `-\n  ---\n\n    ${img}`, `-\n  -\n\n    ${img}`, `-\n  1.\n\n    ${img}`, `-\n  >\n\n    ${img}`, `- -\n\n    ${img}`,
    `-\n  * * *\n\n    ${img}`, `1.\n   ___\n\n    ${img}`, `-\n  \`\`\`\n  \`\`\`\n\n    ${img}`, `-\n  <div>\n\n    ${img}`, `-\n  # h\n\n    ${img}`,
    `-\n  -\n    x\n\n    ${img}`, `| a | b |\n---\n10. a\n\n\t ${img}`, `| a |\n|---|\n10. a\n\n    ${img}`, `| a |\n|---|\n2) a\n\n    ${img}`,
    `| a |\n|---|\n-\n\n    ${img}`, `| a |\n|---|\n- a\n\n    ${img}`, `    x\n10. a\n\n    ${img}`, `    x\n2. a\n\n     ${img}`,
    `    x\n-\n      y\n\n    ${img}`, `    x\n-\n\n    ${img}`, `>\n        y\n10. a\n\n    ${img}`, "| a |\n|---|\n10. a\n\n    ![a](https://evil.test/x.png)",
    `    ${img}`,
  ];
  for (const text of docs) expect(linkImages(text), text).not.toMatch(/<(?:img|video|source)\b|(?<!\\)!\[/i);
});

// BB's Markdown drops a leading BOM and reads an HTML block after it, where backticks are text, but linkImages read
// the BOM as a paragraph's and kept the <img> between them as a code span (bug bash SEC-2).
test("an image in backticks after a BOM and an HTML block's tag stays a link", () => {
  const url = "https://evil.test/x.png";
  for (const tag of ["<b>", "<div>", "<details>", "</div>", "<pre>", "<p align=center>", "<table>"]) {
    expect(linkImages(`\uFEFF${tag}\n\`<img src="${url}">\``)).not.toContain("<img");
    expect(linkImages(`\uFEFF${tag}\nx \`\`<video poster="${url}">\`\` y`)).not.toContain("<video");
  }
  // Without the BOM the same text was already safe.
  expect(linkImages(`<div>\n\`<img src="${url}">\``)).not.toContain("<img");
  // BB drops only one: the BOM is kept, so that it doesn't drop a second, before a tag read as a paragraph's text.
  const twice = `\uFEFF\uFEFF</details>\n\t\`<img src="${url}">\``;
  expect(linkImages(twice)).toBe(twice);
  expect(linkImages(`\uFEFF<b>\n\`<img src="${url}">\``).startsWith("\uFEFF<b>")).toBe(true);
});

test("a link after a `!` doesn't make a new image", () => {
  expect(linkImages("!![x](https://evil.test/a.png)")).toBe("\\![Image: x](https://evil.test/a.png)");
  expect(linkImages("!<img src=https://evil.test/b.png>")).toBe("\\![Image](https://evil.test/b.png)");
  expect(linkImages("\\!![x](a.png)")).toBe("\\![Image: x](a.png)");
});

// Each `![`'s label was worked out, by reading its alt again, before it was known to be an image, so nested ones cost
// 2^depth; and each opener that never closed read on to the end (bug bash SEC-3).
test("nested image openers that close nothing are read in linear time", () => {
  const started = performance.now();
  const out = linkImages(`${"![".repeat(24)}${"]".repeat(24)}`);
  expect(performance.now() - started).toBeLessThan(100);
  expect(out).not.toMatch(/(^|[^\\])!\[/);
}, 60_000);

test("long runs of openers that close nothing, and of images, are read in linear time", () => {
  for (const unit of ["![", "![a](", "![a][b", "![[", "<img ", "<!--", "![a](x '", "![a](<", "![a](u)", "<img src=u>"]) {
    const started = performance.now();
    linkImages(unit.repeat(Math.ceil(64_000 / unit.length)));
    expect(performance.now() - started, unit).toBeLessThan(250);
  }
}, 60_000);

test("in a rendered file, a link's or an image's URL with long runs of spaces inside is read in linear time", () => {
  for (const html of [(url: string) => `<a href="${url}">z</a>`, (url: string) => `<img src="${url}">`]) {
    const started = performance.now();
    linkImages(html(`x${" ".repeat(64_000)}y`), { tree: TREE });
    expect(performance.now() - started).toBeLessThan(250);
  }
}, 60_000);

test("an image in an image's alt text is its words, however deep", () => {
  expect(linkImages("![a ![b](u) c](v)")).toBe("[Image: a Image: b c](v)");
  expect(linkImages("[![a ![b][] c](v)](w)")).toBe("[Image: a Image: b c](w)");
  // Thousands deep, it neither runs out of stack nor grows its label with each level's text.
  const out = linkImages(`${"![".repeat(10_000)}x${"](u)".repeat(10_000)}`);
  expect(out.length).toBeLessThan(200_000);
  expect(out).toMatch(/^\[(Image: ){10000}x\]\(u\)$/);
  expect(linkImages(`${"![".repeat(10_000)}x${"][]".repeat(10_000)}`)).not.toMatch(/(^|[^\\])!\[/);
});

// A kept <scheme: …> that holds a space isn't an autolink to BB, which read an image in it; and a reference image's
// [ref] was copied out unread, an image in it too (bug bash S15, found by the untrusted-parsers harness).
test("an image inside a kept <scheme: …> that BB can't read as an autolink stays text", () => {
  const url = "https://evil.test/x.png";
  expect(linkImages(`<https: !<!-- -->[b](${url}) >`)).toBe(`<https: \\![b](${url}) >`);
  expect(linkImages(`x <https: a !<!-- -->[b](${url}) >`)).toBe(`x <https: a \\![b](${url}) >`);
  expect(linkImages(`<https:!<!-- -->[b](${url})[\t'>>`)).toBe(`<https:\\![b](${url})[\t'>>`);
  // An autolink, without a space, is a link to BB, and stays as written.
  expect(linkImages(`<https:a!<!-- -->[b](${url})>`)).toBe(`<https:a![b](${url})>`);
});

test("a reference image's reference is kept only where it's a label, and read like the rest where it isn't", () => {
  const url = "https://evil.test/x.png";
  expect(linkImages(`![x][ <https: ![b](${url}) >]`)).toBe("\\![x][ <https: Image: b >]");
  expect(linkImages(`![x][a ![b](${url}) c]`)).toBe("\\![x][a Image: b c]");
  expect(linkImages(`![a ![b](${url})][]`)).toBe("\\![a Image: b][]");
  expect(linkImages(`![x][${"a".repeat(1000)}]`)).toBe(`\\![x][${"a".repeat(1000)}]`);
  expect(linkImages(`![x][a\\[b]`)).toBe("[Image: x][a\\[b]");
  expect(linkImages(`![x][r]\n\n[r]: ${url}`)).toBe(`[Image: x][r]\n\n[r]: ${url}`);
});

test("text with no image or HTML, an escaped one, or a plain link is unchanged", () => {
  for (const text of ["Plain words.", "[a link](https://a.example)", "\\![not](an image)", "Ends with !", ""]) expect(linkImages(text)).toBe(text);
});

// Elements that load something when HTML shows them, and attributes that name what to load.
const LOADS = new Set(["img", "image", "video", "audio", "source", "track", "picture", "iframe", "frame", "embed", "object", "link", "script", "style", "input", "svg", "math", "meta", "base", "use", "feimage"]);
const URL_ATTRIBUTES = new Set(["src", "srcset", "poster", "data", "background", "href", "xlink:href", "style", "action", "formaction"]);

const protocolOf = (url: string) => { try { return new URL(url).protocol; } catch { return ""; } };

/**
 * What `markdown`'s HTML would load outside its code, and any `![` there that could be an image. With `anchors`, as a
 * rendered file's text, whose `<a>` may link, with an href alone, to the web or email: any other is found too.
 */
function loads(markdown: string, anchors = false): string[] {
  let rest = "";
  let from = 0;
  for (const [start, end] of codeRanges(markdown, anchors)) {
    rest += `${markdown.slice(from, start)} `;
    from = end;
  }
  rest += markdown.slice(from);
  return [...[...rest.matchAll(/(?<!\\)(?:\\\\)*!\[/g)].map(() => "!["), ...htmlLoads(rest, anchors)];
}

/** What `html`'s elements would load, or with `anchors`, link to but the web or email (`loads`). */
function htmlLoads(html: string, anchors: boolean): string[] {
  const found: string[] = [];
  for (const element of Array.from(new DOMParser().parseFromString(html, "text/html").body.querySelectorAll("*"))) {
    if (LOADS.has(element.localName)) found.push(`<${element.localName}>`);
    // An autolink parses as a tag named like `https:`: no element at all to BB.
    if (element instanceof HTMLUnknownElement) continue;
    for (const { name, value } of Array.from(element.attributes)) {
      if (anchors && element.localName === "a") {
        if (name !== "href" || !["http:", "https:", "mailto:"].includes(protocolOf(value))) found.push(`a[${name}=${value}]`);
      } else if (URL_ATTRIBUTES.has(name)) found.push(`${element.localName}[${name}]`);
    }
  }
  return found;
}

// The probes of 95-recheck (images.mts, images2.mts) and 96-recheck-2 (media.mts).
const PROBES = [
  "![x](https://evil.test/a.png)", "![r]\n\n> [r]: https://evil.test/bq.png", "![r]\n\n- [r]: https://evil.test/li.png", "![a\\]b]\n\n[a\\]b]: https://evil.test/esc.png",
  "![a\nb]\n\n[a\nb]: https://evil.test/ml.png", "<https://a.test/`> ![x](https://evil.test/al.png) <https://b.test/`>", "<a title=\"`\"> ![x](https://evil.test/ht.png) <a title=\"`\">",
  "1. item\n   ```\n   code\nend\n\n![x](https://evil.test/lf.png)", "![ẞ]\n\n[ß]: https://evil.test/uc.png", "![r]\n\n[r]:\n  https://evil.test/nl.png",
  "<div>\n```\n<img src=\"https://evil.test/hb.png\">\n```\n</div>", "<span>\n```\n<img src=\"https://evil.test/hb7.png\">\n```\n</span>", "<div>\n\n```\n![x](https://evil.test/hbm.png)\n```\n\n</div>",
  "&#33;[x](https://evil.test/ent.png)", "<IMG SRC=https://evil.test/up.png>", "<img\nsrc=\"https://evil.test/nl2.png\">", "<img/src=\"https://evil.test/sl.png\">", "![x](https://evil.test/a(b).png)",
  "![a [b](c) d](https://evil.test/la.png)", "![a [b] c](https://evil.test/br.png)", "~~~ `x`\n![x](https://evil.test/tf.png)\n~~~", "\t```\n![x](https://evil.test/tab.png)\n```",
  "<!--\n```\n-->\n<img src=https://evil.test/cm.png>\n```", "```\nx\n   ```\n![x](https://evil.test/ci.png)", "> ```\n> ![x](https://evil.test/bqf.png)\n> ```",
  "<picture><source srcset=https://evil.test/p.png></picture>", "<svg><image href=https://evil.test/s.png /></svg>",
  "<!--\n```\n-->\n![x](https://evil.test/cmd.png)\n```", "<div>\n```\n</div>\n\n![x](https://evil.test/dmd.png)\n```", "<pre>\n```\n</pre>\n![x](https://evil.test/pre.png)\n```",
  "<script>\n```\n</script>\n![x](https://evil.test/scr.png)\n```", "<?\n```\n?>\n![x](https://evil.test/pi.png)\n```", "<![CDATA[\n```\n]]>\n![x](https://evil.test/cd.png)\n```",
  "    ```\n![x](https://evil.test/ic.png)\n```", "```a\n![x](https://evil.test/it.png)\n```", "~~~~\n![x](https://evil.test/tsc.png)\n~~~\n~~~~", "Title\n```\n![x](https://evil.test/sh.png)\n```",
  '<vi<source>deo poster="https://evil.test/p.png"></video>', '<im<source>g src="https://evil.test/i.png">', '<<img> src="https://evil.test/x.png">',
  '[<![](u) src="https://evil.test/y.png">](https://z.test)', '<video poster="https://evil.test/p.png"></video>',
];

test("the recheck's probes load nothing outside code", () => {
  for (const probe of PROBES) expect([probe, loads(linkImages(probe))]).toEqual([probe, []]);
});

// HTML that loads something, written each way the rechecks found, and the Markdown around it that changes what's code.
const FRAGMENTS = [
  '<img src="https://evil.test/1.png">', "<image src=https://evil.test/2.png>", "<svg><image href=\"https://evil.test/3.png\"/></svg>", "<picture><source srcset=\"https://evil.test/4.png 1x\"></picture>",
  '<video poster="https://evil.test/5.png"><source src="https://evil.test/5.mp4"></video>', '<vi<source>deo poster="https://evil.test/6.png">', '<iframe src="https://evil.test/7"></iframe>',
  '<object data="https://evil.test/8"></object>', '<embed src="https://evil.test/9">', '<link rel="stylesheet" href="https://evil.test/10.css">', '<input type="image" src="https://evil.test/11.png">',
  '<table background="https://evil.test/12.png"><tr><td background="https://evil.test/13.png">x</td></tr></table>', '<img srcset="https://evil.test/14.png 2x">', '<img src="data:image/png;base64,AAAA">',
  '<p style="background:url(https://evil.test/15.png)">', "&lt;img src=x&gt;<img src=\"https://evil.test/16.png\" alt=\"a&quot;b\">", '<img src="https://evil.test/17.png"', "<img <img src=https://evil.test/18.png>",
  '<details><summary><img src="https://evil.test/19.png"></summary></details>', '<!-- --><img src="https://evil.test/20.png">', '<b title="x"><img src="https://evil.test/21.png"></b>',
  "![x](https://evil.test/22.png)", "`<img src=\"https://evil.test/23.png\">`", "``a ` <img src=\"https://evil.test/24.png\"> ``",
];
const CONTEXTS: Array<(html: string) => string> = [
  (html) => html,
  (html) => `Text ${html} more`,
  (html) => `<details>\n\`\`\`\n${html}\n\`\`\`\n\n</details>`,
  (html) => `<pre>\n\`\`\`\n</pre>\n${html}\n\`\`\``,
  (html) => `<div>\n\`\`\`\n</div>\n\n${html}\n\`\`\``,
  (html) => `<!--\n\`\`\`\n-->\n${html}\n\`\`\``,
  (html) => `- item\n  \`\`\`\n${html}\n\`\`\``,
  (html) => `> \`\`\`\n${html}\n\`\`\``,
  (html) => `| a | b |\n|---|---|\n| \`x | ${html} | y\` |`,
  (html) => `[a](u\`) ${html} \`b\``,
  (html) => `[r]: u "\n\`\`\`\n"\n${html}\n\`\`\``,
  (html) => `$$\n\`\`\`\n$$\n${html}\n\`\`\``,
  (html) => `\t\`\`\`\n${html}\n\`\`\``,
  (html) => `<b>\n\`\`\`\n${html}\n\`\`\``,
  // A link's tag alone on its line begins an HTML block where a rendered file keeps it: what follows isn't a fence.
  (html) => `<a href="https://ok.test">\n\`\`\`\n${html}\n\`\`\``,
  (html) => `x \`y\n${html}\n\`z\``,
];

test("no HTML that loads, written any way, in any of these places, survives outside code", () => {
  for (const fragment of FRAGMENTS) {
    for (const html of [fragment, fragment.toUpperCase()]) {
      for (const context of CONTEXTS) {
        const text = context(html);
        expect([text, loads(linkImages(text))]).toEqual([text, []]);
      }
    }
  }
});

test("a relative link's URL, and its definition's, go to the file's folder in the given tree; others stay", () => {
  const tree = { root: "https://github.com/acme/web/blob/abc123/", path: "docs/auth/rfc-auth.md" };
  expect(resolveLinks("See [the RFC](rfc.md#goals), [setup](../setup.md 'Setup'), [root](/README.md), and [x][x].\n\n[x]: ./x.md", tree))
    .toBe("See [the RFC](https://github.com/acme/web/blob/abc123/docs/auth/rfc.md#goals), [setup](https://github.com/acme/web/blob/abc123/docs/setup.md 'Setup'), [root](https://github.com/acme/web/blob/abc123/README.md), and [x][x].\n\n[x]: https://github.com/acme/web/blob/abc123/docs/auth/x.md");
  expect(resolveLinks("[web](https://x.io), [mail](mailto:a@b.c), [proto](//cdn.io/a)", tree)).toBe("[web](https://x.io), [mail](mailto:a@b.c), [proto](//cdn.io/a)");
  expect(resolveLinks("Write `[code](rel.md)` here.\n\n```md\n[code](rel.md)\n```", tree)).toBe("Write `[code](rel.md)` here.\n\n```md\n[code](rel.md)\n```");
  // An image already a link to it keeps the rule: it loads nothing until clicked, from the tree.
  expect(resolveLinks(linkImages("![chart](img/chart.png)"), tree)).toBe("[Image: chart](https://github.com/acme/web/blob/abc123/docs/auth/img/chart.png)");
});

test("only a real link definition's URL is resolved, not a line that looks like one, nor a footnote's", () => {
  const tree = { root: "https://github.com/acme/web/blob/abc123/", path: "docs/guide.md" };
  expect(resolveLinks("Read this.\n[Note]: this is important\n\n[^1]: Footnote text.\n\n[x]: x.md", tree))
    .toBe("Read this.\n[Note]: this is important\n\n[^1]: Footnote text.\n\n[x]: https://github.com/acme/web/blob/abc123/docs/x.md");
});

test("a query or fragment alone goes to the file itself, a folder's # is its name, and ../ stops at the repository's root", () => {
  const tree = { root: "https://github.com/acme/web/blob/abc123/", path: "docs/C#/guide.md" };
  expect(resolveLinks("[raw](?plain=1), [goals](#goals), [next](next.md), [up](../../../x.md)", tree))
    .toBe("[raw](https://github.com/acme/web/blob/abc123/docs/C%23/guide.md?plain=1), [goals](https://github.com/acme/web/blob/abc123/docs/C%23/guide.md#goals), [next](https://github.com/acme/web/blob/abc123/docs/C%23/next.md), [up](https://github.com/acme/web/blob/abc123/x.md)");
});

const TREE = { root: "https://github.com/acme/web/blob/abc123/", path: "docs/README.md" };

test("the comments of others and agents show an <a> as text", () => {
  expect(linkImages('See <a href="https://a.example/x">the docs</a>.')).toBe('See &lt;a href="https://a.example/x">the docs&lt;/a>.');
});

test("a rendered file's <a> keeps its href alone, a web or email link, or a relative one as its file in the tree", () => {
  expect(linkImages('<a href="https://acme.dev/x" target="_self" rel="opener" title="t" id="top" name="n" style="color:red" onclick="steal()">site</a>', { tree: TREE }))
    .toBe('<a href="https://acme.dev/x">site</a>');
  expect(linkImages('<a href="mailto:dev@acme.dev?subject=Hi there">mail</a> <A HREF=guide.md#setup>guide</A> <a href="#top">top</a> <a href="/LICENSE">license</a>', { tree: TREE }))
    .toBe('<a href="mailto:dev@acme.dev?subject=Hi%20there">mail</a> <a href="https://github.com/acme/web/blob/abc123/docs/guide.md#setup">guide</a> <a href="https://github.com/acme/web/blob/abc123/docs/README.md#top">top</a> <a href="https://github.com/acme/web/blob/abc123/LICENSE">license</a>');
  // The first href, as an HTML parser takes it.
  expect(linkImages('<a href="https://acme.dev/" href="javascript:alert(1)">x</a>', { tree: TREE })).toBe('<a href="https://acme.dev/">x</a>');
  // Written plain: `&` as `&amp;`, and what an attribute or Markdown would read otherwise percent-encoded.
  expect(linkImages("<a href='https://x.io/a(b)/[c]?q=1&r=2&amp;s=3#f'>x</a>", { tree: TREE })).toBe('<a href="https://x.io/a%28b%29/%5Bc%5D?q=1&amp;r=2&amp;s=3#f">x</a>');
  // A kept link's tag is a tag, so a code span after it is one: its HTML stays as written.
  expect(linkImages('<a href="https://ok.test/">`<span>`</a>', { tree: TREE })).toBe('<a href="https://ok.test/">`<span>`</a>');
  // A user and password that hide the link's host behind them are dropped.
  expect(linkImages('<a href="https://github.com@evil.test/login">GitHub</a>', { tree: TREE })).toBe('<a href="https://evil.test/login">GitHub</a>');
});

test("a rendered file's <a> to anything but the web or email, or relative with no tree, is its words", () => {
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "\u0001javascript:alert(1)", "vbscript:x", "data:text/html,<b>x</b>", "file:///etc/passwd", "vscode://file/etc/passwd", "//evil.test/x", "\\\\evil.test\\x", ""]) {
    expect(linkImages(`<a href="${href.replace(/[<>"]/g, "")}">x</a>`, { tree: TREE })).toBe("<a>x</a>");
  }
  // A character reference spells no scheme: the href is a relative one, in the tree.
  expect(linkImages('<a href="javascript&#58;alert(1)">x</a>', { tree: TREE })).toBe('<a href="https://github.com/acme/web/blob/abc123/docs/javascript&amp;#58;alert%281%29">x</a>');
  expect(linkImages('<a href="guide.md">guide</a> <a href="#top">top</a> <a name="top"></a> <a href="https://acme.dev/">site</a>', { tree: null }))
    .toBe('<a>guide</a> <a>top</a> <a></a> <a href="https://acme.dev/">site</a>');
  // In a table's row, GFM splits the cells at a `|` before it reads any tag: an <a> holding one isn't one, and shows as text.
  expect(linkImages('| a | b |\n|---|---|\n| <a title="x|y" href="https://ok.test">t</a> | z |', { tree: TREE })).toBe('| a | b |\n|---|---|\n| &lt;a title="x|y" href="https://ok.test">t</a> | z |');
  // A tag that isn't plainly one, as one that a line break or a quote or backtick in its value splits, shows as text.
  expect(linkImages('<a href="https://a.example"\n>x</a> <a href=\'a"b\'>y</a> <a href="`">z</a>', { tree: TREE })).toBe('&lt;a href="https://a.example"\n>x</a> &lt;a href=\'a"b\'>y</a> &lt;a href="`">z</a>');
});

test("a rendered file's HTML image is a link to it, its words inside a link, and a <picture> its <img> alone", () => {
  expect(linkImages('<p align="center">\n  <img src="docs/logo.png" alt="Logo" width="120">\n</p>', { tree: TREE }))
    .toBe('<p align="center">\n  <a href="https://github.com/acme/web/blob/abc123/docs/docs/logo.png">Image: Logo</a>\n</p>');
  expect(linkImages('<div align="center">\n  <a href="https://acme.dev"><img src="logo.svg" alt="Acme"></a>\n</div>', { tree: TREE }))
    .toBe('<div align="center">\n  <a href="https://acme.dev/">Image: Acme</a>\n</div>');
  expect(linkImages('<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="dark.png">\n  <img src="light.png" alt="Shot">\n</picture>', { tree: TREE }))
    .toBe('\n  \n  <a href="https://github.com/acme/web/blob/abc123/docs/light.png">Image: Shot</a>\n');
  expect(linkImages('<img src="data:image/png;base64,AAAA" alt="x"> <img src="logo.png" alt="y">', { tree: null })).toBe("Image: x Image: y");
});

test("resolveLinks leaves a rendered file's kept links alone, and resolves its Markdown links", () => {
  const kept = linkImages('<a href="https://x.io/a](b)">x</a> and [the guide](guide.md)', { tree: TREE });
  expect(resolveLinks(kept, TREE)).toBe('<a href="https://x.io/a%5D%28b%29">x</a> and [the guide](https://github.com/acme/web/blob/abc123/docs/guide.md)');
  // A kept tag's attribute that reads like a link's end stays as written: its closing quote went into the URL.
  expect(resolveLinks(linkImages('<p align="a](b">x</p> then " title="t', { tree: TREE }), TREE)).toBe('<p align="a](b">x</p> then " title="t');
});

test("resolveLinks keeps a destination it can't resolve as written, as one the URL parser reads as a host", () => {
  for (const url of ["\\\\a:99999/b", "\\\\evil.test/x", "/\\evil.test/x"]) expect(resolveLinks(`[x](${url})`, TREE)).toBe(`[x](${url})`);
});

/**
 * What `markdown` would load, or link to but the web or email, as micromark reads it, as BB's Markdown does: its images,
 * and its raw HTML's, read apart from linkImages's own reading of what's code.
 */
function drawnLoads(markdown: string): string[] {
  const found: string[] = [];
  let html = "";
  const walk = (node: Nodes) => {
    if (node.type === "image" || node.type === "imageReference") found.push(node.type);
    if (node.type === "html") html += node.value;
    if ("children" in node) node.children.forEach(walk);
  };
  walk(parseMarkdown(markdown));
  return [...found, ...htmlLoads(html, true)];
}

const ANCHORS = [
  '<a href="javascript:alert(1)">x</a>', '<a href=" jav&#x09;ascript:alert(1)">x</a>', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', "<a href=vbscript:x>x</a>",
  '<a href="https://ok.test" onclick="x()" style="background:url(https://evil.test/s.png)" ping="https://evil.test/p">x</a>', "<a href=https://ok.test><img src=https://evil.test/a.png></a>",
  '<a href="https://ok.test"\nonclick=x>x</a>', '<a href="javascript:y" href="https://ok.test">x</a>', '<a href="//evil.test/x">x</a>', '<a href="https://ok.test/`">x</a>',
  '<a href="https://ok.test/"><picture><source srcset="https://evil.test/p.png"><img src="https://evil.test/q.png"></picture></a>', '<a name="x" id="y" href="#z">x</a>',
];

test("in a rendered file, no HTML that loads, and no link but to the web or email, written any way, in any of these places, survives outside code", () => {
  for (const fragment of [...FRAGMENTS, ...ANCHORS]) {
    for (const html of [fragment, fragment.toUpperCase()]) {
      for (const context of CONTEXTS) {
        const text = context(html);
        for (const tree of [TREE, null]) {
          const drawn = linkImages(text, { tree });
          expect([text, loads(drawn, true), drawnLoads(drawn)]).toEqual([text, [], []]);
        }
        expect([text, loads(resolveLinks(linkImages(text, { tree: TREE }), TREE), true)]).toEqual([text, []]);
      }
    }
  }
  for (const probe of PROBES) expect([probe, loads(linkImages(probe, { tree: TREE }), true)]).toEqual([probe, []]);
});
