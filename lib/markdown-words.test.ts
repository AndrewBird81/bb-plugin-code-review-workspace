import { expect, test } from "vitest";
import { rng } from "../src/fuzz-gen.test-support";
import { blockWords, markWords } from "./markdown-words";
import type { MarkdownBlock } from "./markdown-blocks";

// From microsoft/vscode-docs 90c4efb ("Align keyboard shortcuts terminology"), which GitHub's rich diff marks word by word.
test("a list item's changed words are marked, deleted then inserted, as GitHub does", () => {
  const old = "* `setting(inlineChat.holdToSpeech)`: Whether holding the Inline Chat keybinding will automatically enable speech recognition.";
  const now = "* `setting(inlineChat.holdToSpeech)`: Whether holding the Inline Chat keyboard shortcut will automatically enable speech recognition.";
  expect(markWords(old, now)).toBe("* `setting(inlineChat.holdToSpeech)`: Whether holding the Inline Chat <del>keybinding</del><ins>keyboard shortcut</ins> will automatically enable speech recognition.");
});

test("two changed words a space apart are one change", () => {
  const old = "You can also set your own keyboard shortcuts. Discover and modify key bindings for VS Code actions.";
  const now = "You can also set your own keyboard shortcuts. Discover and modify keyboard shortcuts for VS Code actions.";
  expect(markWords(old, now)).toBe("You can also set your own keyboard shortcuts. Discover and modify <del>key bindings</del><ins>keyboard shortcuts</ins> for VS Code actions.");
});

// From microsoft/vscode-docs ba663bc ("Add replace history"): an added code span is marked whole.
test("words and a code span added and removed across a paragraph are each marked", () => {
  const old = "By default, VS Code saves the history of your find queries for a workspace and restores it across restarts. You can configure this behavior with the `setting(editor.find.history)` setting. Set the value to `never` to disable saving the find history.";
  const now = "By default, VS Code saves the history of your find and replace queries for a workspace and restores it across restarts. You can configure this behavior with the `setting(editor.find.history)` and `setting(editor.find.replaceHistory)` settings. Set the value to `never` to disable saving the history.";
  expect(markWords(old, now)).toBe("By default, VS Code saves the history of your find <ins>and replace</ins> queries for a workspace and restores it across restarts. You can configure this behavior with the `setting(editor.find.history)` <del>setting</del><ins>and `setting(editor.find.replaceHistory)` settings</ins>. Set the value to `never` to disable saving the <del>find</del> history.");
});

// From microsoft/vscode-docs 8bc2e69: only the link's URL changed, which marking would show as the same words twice.
test("a changed link's URL isn't marked", () => {
  const old = "Get more info about [Keyboard Shortcuts editor](/docs/getstarted/keybindings.md#keyboard-shortcuts-editor).";
  expect(markWords(old, old.replace("getstarted", "editor"))).toBeNull();
});

test("a change across emphasis, a task's box, a heading's level, or an HTML tag isn't marked", () => {
  expect(markWords("Use **bold** here.", "Use bold here.")).toBeNull();
  expect(markWords("Use bold here.", "Use _bold_ here.")).toBeNull();
  expect(markWords("- [ ] Ship it", "- [x] Ship it")).toBeNull();
  expect(markWords("## Rotation", "### Rotation")).toBeNull();
  expect(markWords("Press Ctrl to copy.", "Press <kbd>Ctrl</kbd> to copy.")).toBeNull();
  expect(markWords("Title\n=====", "Title\n===")).toBeNull();
});

test("words inside unchanged emphasis, tags, and code are marked inside them", () => {
  expect(markWords("This is **important** now.", "This is **critical** now.")).toBe("This is **<del>important</del><ins>critical</ins>** now.");
  // Emphasis that takes in a word: the word as it was, and as it is.
  expect(markWords("**Bold** text here.", "**Bold text** here.")).toBe("**Bold <ins>text</ins>** <del>text</del> here.");
  expect(markWords("Press <kbd>Ctrl</kbd> to copy.", "Press <kbd>Cmd</kbd> to copy.")).toBe("Press <kbd><del>Ctrl</del><ins>Cmd</ins></kbd> to copy.");
});

test("a line added to a paragraph is marked on its own line; a removed line joins the one before", () => {
  expect(markWords("First line\nsecond line.", "First line\nsecond line.\nAnd a third.")).toBe("First line\nsecond line.\n<ins>And a third.</ins>");
  expect(markWords("First line\nsecond line.\nAnd a third.", "First line\nsecond line.")).toBe("First line\nsecond line. <del>And a third.</del>");
});

test("text rewrapped over other lines, or changed only in whitespace, has nothing to mark", () => {
  expect(markWords("One two three\nfour five.", "One two\nthree four five.")).toBeNull();
  expect(markWords("One  two.", "One two. ")).toBeNull();
});

test("text that shares too little isn't marked word by word", () => {
  expect(markWords("Tokens expire after an hour.", "Refresh rotates every single use now.")).toBeNull();
});

// Whatever it marks, the marks read back as both texts: without the deleted words, the new one; without the inserted, the old.
test("marked text without its deletions is the new text, and without its insertions the old, whitespace aside", () => {
  const r = rng(2026);
  const pool = ["token", "rotation", "**bold**", "`code`", "[link](https://example.com)", "client,", "gateway.", "re-use", "it's", "&amp;", "<kbd>K</kbd>", "_em_"];
  const sentence = () => Array.from({ length: r.int(3, 30) }, () => r.pick(pool)).join(" ");
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  let marked = 0;
  for (let run = 0; run < 2000; run++) {
    const old = sentence();
    const words = old.split(" ");
    for (let k = r.int(1, 4); k > 0; k--) {
      const at = r.int(0, words.length - 1);
      if (r.bool()) words.splice(at, 1, r.pick(pool)); else if (r.bool()) words.splice(at, 0, r.pick(pool)); else words.splice(at, 1);
    }
    const now = words.join(r.bool(0.2) ? "\n" : " ");
    const out = markWords(old, now);
    if (out === null) continue;
    marked++;
    expect(flat(out.replace(/<del>[^]*?<\/del>/g, " ").replace(/<\/?ins>/g, "")), JSON.stringify({ old, now, out })).toBe(flat(now));
    expect(flat(out.replace(/<ins>[^]*?<\/ins>/g, " ").replace(/<\/?del>/g, "")), JSON.stringify({ old, now, out })).toBe(flat(old));
  }
  expect(marked).toBeGreaterThan(500);
});

const block = (kind: string, source: string, extra: Partial<MarkdownBlock> = {}): MarkdownBlock => ({ kind, start: 1, end: source.split("\n").length, source, ...extra });

test("a block marks words only where its kind is prose, with its images as links and the document's definitions", () => {
  expect(blockWords(block("paragraph", "See ![the chart](a.png) and [the docs][d]."), block("paragraph", "See ![the chart](a.png) and all [the docs][d]."), "[d]: https://example.com"))
    .toBe("See [Image: the chart](a.png) and <ins>all</ins> [the docs][d].\n\n[d]: https://example.com");
  expect(blockWords(block("code", "```ts\nconst x = 1;\n```"), block("code", "```ts\nconst x = 2;\n```"), "")).toBeNull();
  expect(blockWords(block("table", "| a |\n|---|\n| 1 |"), block("table", "| a |\n|---|\n| 2 |"), "")).toBeNull();
  expect(blockWords(block("paragraph", "$$\na + b\n$$"), block("paragraph", "$$\na + c\n$$"), "")).toBeNull();
  expect(blockWords(block("listItem", "- Run:\n\n  ```sh\n  npm test\n  ```"), block("listItem", "- Run:\n\n  ```sh\n  npm run test\n  ```"), "")).toBeNull();
  expect(blockWords(block("paragraph", "Old words."), block("heading", "# New words."), "")).toBeNull();
});

test("an ordered list's item marks its words, numbered as it draws now", () => {
  const list = { marker: ".", loose: false };
  expect(blockWords(block("listItem", "2. Run the old tests.", { list: { ...list, number: 2 } }), block("listItem", "2. Run the new tests.", { list: { ...list, number: 3 } }), ""))
    .toBe("3. Run the <del>old</del><ins>new</ins> tests.");
});

// The word diff runs on every changed block of a document; a quadratic diff would freeze the tab on a big rewrite.
test("marking words in thousands of long changed paragraphs takes reasonable time", () => {
  const words = (seed: number) => Array.from({ length: 80 }, (_, i) => `w${(seed * 31 + i * 7) % 997}`);
  const start = performance.now();
  for (let i = 0; i < 2000; i++) {
    const old = words(i);
    const now = old.map((word, at) => (at % 9 === 0 ? `${word}x` : word));
    markWords(old.join(" "), now.join(" "));
  }
  // A paragraph whose every word changed reaches the edit cap and stops.
  const long = Array.from({ length: 5000 }, (_, i) => `a${i}`).join(" ");
  expect(markWords(long, long.replace(/a/g, "b"))).toBeNull();
  expect(performance.now() - start).toBeLessThan(3000);
});
