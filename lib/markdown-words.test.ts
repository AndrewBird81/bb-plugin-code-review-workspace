import { expect, test } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Nodes } from "mdast";
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

// Marks the atoms allowed that CommonMark read otherwise (reviewer's B1): each drew something other than the new block.
test("words added or removed before punctuation are marked", () => {
  expect(markWords("- Refresh tokens rotate.", "- Refresh tokens rotate on every use.")).toBe("- Refresh tokens rotate <ins>on every use</ins>.");
  expect(markWords("Rotate them on every use.", "Rotate them.")).toBe("Rotate them <del>on every use</del>.");
});

test("marks that would change what the block draws aren't made", () => {
  // Intraword emphasis, as in CJK, where every emphasised word is intraword: the marks stop ** from closing.
  expect(markWords("Call the **API**s here.", "Call the **SDK**s here.")).toBeNull();
  expect(markWords("这是**重要**的设置。", "这是**关键**的设置。")).toBeNull();
  // A shortcut reference link: its label, marked, matches no definition.
  expect(markWords("See [RFC 1234] now.\n\n[RFC 1234]: https://a\n[RFC 5678]: https://b", "See [RFC 5678] now.\n\n[RFC 1234]: https://a\n[RFC 5678]: https://b")).toBeNull();
  // A code span wrapped over two lines, and indented code in a list item or quote: the marks would show as text.
  expect(markWords("Run the `npm run\nbuild` command first.", "Run the `npm run\nlint` command first.")).toBeNull();
  expect(markWords("- Run:\n\n      npm run build", "- Run:\n\n      npm run lint")).toBeNull();
  expect(markWords("> Run:\n>\n>     npm run build", "> Run:\n>\n>     npm run lint")).toBeNull();
});

const parse = (text: string) => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
/**
 * What a Markdown tree draws, for one side of marked text: `keep` "ins" drops each <del>…</del> and the <ins> tags, "del"
 * the reverse. Types, text and values without whitespace, URLs and labels.
 */
function drawn(node: Nodes, keep: "ins" | "del" | null, state = { dropping: false }): unknown {
  if (!("children" in node)) return [node.type, "value" in node ? node.value.replace(/\s+/g, "") : null];
  const children: unknown[] = [];
  let text = "";
  const flush = () => { if (text.trim()) children.push(["text", text.replace(/\s+/g, "")]); text = ""; };
  for (const child of node.children) {
    const tag = child.type === "html" && keep ? child.value.match(/^<(\/?)(del|ins)>$/) : null;
    if (tag) { if (tag[2] !== keep) state.dropping = !tag[1]; continue; }
    if (state.dropping) continue;
    if (child.type === "text") { text += child.value; continue; }
    flush();
    children.push(drawn(child, keep, state));
  }
  flush();
  return [node.type, "url" in node ? node.url : null, "identifier" in node ? node.identifier : null, "depth" in node ? node.depth : null, children];
}
const leaks = (node: Nodes): boolean => ("value" in node && node.type !== "html" && /<\/?(?:del|ins)>/.test(node.value)) || ("children" in node && node.children.some(leaks));

// Whatever it marks reads, without the deletions, as the new block draws, and without the insertions as the old one: over
// prose that holds emphasis inside words, CJK, links and shortcut references, code spans over two lines, and indented code.
test("marked text draws as the new block without its deletions, and as the old without its insertions", () => {
  const r = rng(2026);
  const words = ["token", "expires", "client", "API", "refresh", "keyboard", "设置", "重要", "über", "e.g.", "v1.2", "don't"];
  const piece = () => r.pick([
    () => r.pick(words), () => `**${r.pick(words)}**`, () => `*${r.pick(words)}*`, () => `_${r.pick(words)}_`, () => `\`${r.pick(words)}\``,
    () => `[${r.pick(words)}](https://x.io/${r.pick(words)})`, () => "[token gateway]", () => `${r.pick(words)}**${r.pick(words)}**${r.pick(words)}`,
    () => `**${r.pick(words)}**${r.pick(words)}`, () => "&amp;", () => "\\*", () => `<kbd>${r.pick(words)}</kbd>`, () => `\`${r.pick(words)}\n${r.pick(words)}\``,
  ])();
  const definitions = "\n\n[token gateway]: https://ref.io";
  let marked = 0;
  for (let run = 0; run < 3000; run++) {
    const prefix = r.pick(["", "- ", "1. ", "## ", "> ", "- [ ] "]);
    const body = Array.from({ length: r.int(3, 12) }, () => (r.bool(0.35) ? piece() : r.pick(words))).join(r.bool(0.15) ? "\n" : " ");
    const parts = body.split(" ");
    for (let k = r.int(1, 3); k > 0; k--) {
      const at = r.int(0, parts.length - 1);
      if (r.bool()) parts.splice(at, 1, r.pick(words)); else if (r.bool()) parts.splice(at, 0, r.pick(words)); else parts.splice(at, 1);
    }
    // Now and then, indented code under the item or quote.
    const code = prefix === "- " || prefix === "> " ? r.pick(["", `\n${prefix === "> " ? ">" : ""}\n${prefix === "> " ? "> " : "  "}    npm run ${r.pick(words)}`]) : "";
    const old = `${prefix}${body}${code}${definitions}`;
    const now = `${prefix}${parts.join(" ")}${code && r.bool(0.5) ? code.replace(/run \S+$/, `run ${r.pick(words)}`) : code}${definitions}`;
    const out = markWords(old, now);
    if (out === null) continue;
    marked++;
    const tree = parse(out);
    expect(leaks(tree), JSON.stringify({ old, now, out })).toBe(false);
    expect(drawn(tree, "ins"), JSON.stringify({ old, now, out })).toEqual(drawn(parse(now), null));
    expect(drawn(tree, "del"), JSON.stringify({ old, now, out })).toEqual(drawn(parse(old), null));
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

// A <del> of the author's would take the tint of a deletion, as would GFM's strikethrough.
test("a block with strikethrough, or <del> or <ins> of its own, marks no words", () => {
  expect(blockWords(block("paragraph", "Use ~~v1~~ v2 now."), block("paragraph", "Use ~~v1~~ v3 now."), "")).toBeNull();
  expect(blockWords(block("paragraph", "Use v2 now."), block("paragraph", "Use ~~v2~~ v3 now."), "")).toBeNull();
  expect(blockWords(block("paragraph", "Use <del>v1</del> v2 now."), block("paragraph", "Use <del>v1</del> v3 now."), "")).toBeNull();
  expect(blockWords(block("paragraph", "Use <ins>v2</ins> now."), block("paragraph", "Use <ins>v3</ins> now."), "")).toBeNull();
});

test("an ordered list's item marks its words, numbered as it draws now", () => {
  const list = { marker: ".", loose: false };
  expect(blockWords(block("listItem", "2. Run the old tests.", { list: { ...list, number: 2 } }), block("listItem", "2. Run the new tests.", { list: { ...list, number: 3 } }), ""))
    .toBe("3. Run the <del>old</del><ins>new</ins> tests.");
});

// The word diff runs on every changed block of a document; a quadratic diff would freeze the tab on a big rewrite.
test("marking words in hundreds of long changed paragraphs takes reasonable time", () => {
  const words = (seed: number) => Array.from({ length: 80 }, (_, i) => `w${(seed * 31 + i * 7) % 997}`);
  const start = performance.now();
  for (let i = 0; i < 500; i++) {
    const old = words(i);
    const now = old.map((word, at) => (at % 9 === 0 ? `${word}x` : word));
    markWords(old.join(" "), now.join(" "));
  }
  // A paragraph whose every word changed reaches the edit cap and stops.
  const long = Array.from({ length: 5000 }, (_, i) => `a${i}`).join(" ");
  expect(markWords(long, long.replace(/a/g, "b"))).toBeNull();
  expect(performance.now() - start).toBeLessThan(3000);
});
