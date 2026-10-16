import { expect, test } from "vitest";
import { codeRanges, linkImages } from "./link-images";

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
  expect(linkImages('| a | `<img src="https://evil.test/t.png">` |\n|---|---|')).toBe("| a | `[Image](https://evil.test/t.png)` |\n|---|---|");
  expect(linkImages('See [x](u`) <img src="https://evil.test/r.png"> `y`')).toBe("See [x](u`) [Image](https://evil.test/r.png) `y`");
  expect(linkImages('https://a.test/` `a`<img src="https://evil.test/l.png">`')).toBe("https://a.test/` `a`[Image](https://evil.test/l.png)`");
  // A fence in a list item ends with the item.
  expect(linkImages("- item\n  ```\n![p](https://evil.example/b.png)")).toBe("- item\n  ```\n[Image: p](https://evil.example/b.png)");
  expect(linkImages("1. item\n   ```\nend\n![x](https://evil.test/lf.png)\n```")).toBe("1. item\n   ```\nend\n[Image: x](https://evil.test/lf.png)\n```");
  // Math, a directive, a definition's title and a tab can each hide where a fence is.
  for (const before of ["$$\n```\n$$", ":::note\n```\n:::", '[a]: u "\n```\n"', "\t```\nx\n```"]) {
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

// An ordered item can interrupt a paragraph only from 1, so after "a" an "01." line goes on with it, and BB read the
// "fence" in it as text with raw HTML (96-fixes-4).
test("a list item that can't interrupt a paragraph begins no fence", () => {
  expect(linkImages('a\n01. b\n    ``` <img src="https://evil.test/x.png">')).toBe("a\n01. b\n    ``` [Image](https://evil.test/x.png)");
  expect(linkImages('a\n01. b\n    ```\n    <img src="https://evil.test/x.png">')).toBe("a\n01. b\n    ```\n    [Image](https://evil.test/x.png)");
  // From 1 it does.
  expect(linkImages("a\n1. b\n   ```\n   <img src={logo} />\n   ```")).toBe("a\n1. b\n   ```\n   <img src={logo} />\n   ```");
});

test("a link after a `!` doesn't make a new image", () => {
  expect(linkImages("!![x](https://evil.test/a.png)")).toBe("\\![Image: x](https://evil.test/a.png)");
  expect(linkImages("!<img src=https://evil.test/b.png>")).toBe("\\![Image](https://evil.test/b.png)");
  expect(linkImages("\\!![x](a.png)")).toBe("\\![Image: x](a.png)");
});

test("text with no image or HTML, an escaped one, or a plain link is unchanged", () => {
  for (const text of ["Plain words.", "[a link](https://a.example)", "\\![not](an image)", "Ends with !", ""]) expect(linkImages(text)).toBe(text);
});

// Elements that load something when HTML shows them, and attributes that name what to load.
const LOADS = new Set(["img", "image", "video", "audio", "source", "track", "picture", "iframe", "frame", "embed", "object", "link", "script", "style", "input", "svg", "math", "meta", "base", "use", "feimage"]);
const URL_ATTRIBUTES = new Set(["src", "srcset", "poster", "data", "background", "href", "xlink:href", "style", "action", "formaction"]);

/** What `markdown`'s HTML would load outside its code, and any `![` there that could be an image. */
function loads(markdown: string): string[] {
  let rest = "";
  let from = 0;
  for (const [start, end] of codeRanges(markdown)) {
    rest += `${markdown.slice(from, start)} `;
    from = end;
  }
  rest += markdown.slice(from);
  const found = [...rest.matchAll(/(?<!\\)(?:\\\\)*!\[/g)].map(() => "![");
  for (const element of Array.from(new DOMParser().parseFromString(rest, "text/html").body.querySelectorAll("*"))) {
    if (LOADS.has(element.localName)) found.push(`<${element.localName}>`);
    // An autolink parses as a tag named like `https:`: no element at all to BB.
    if (element instanceof HTMLUnknownElement) continue;
    for (const { name } of Array.from(element.attributes)) if (URL_ATTRIBUTES.has(name)) found.push(`${element.localName}[${name}]`);
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
