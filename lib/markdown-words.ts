import { diffArrays } from "diff";
import { CONFETTI_THRESHOLD } from "./confetti";
import { codeRanges, linkImages } from "./link-images";
import type { Nodes } from "mdast";
import { blockMarkdown, parseMarkdown, type MarkdownBlock } from "./markdown-blocks";

/**
 * A piece of a block's Markdown that changes whole: a run of whitespace, a word or a mark of punctuation, a code span, a
 * link's `[` (`open`) and its `](url)` or `][label]` (`close`), with its words between them, an image, an autolink or a
 * bare URL (`link`), or Markdown's syntax (`syntax`): a line's list marker, task box, quote or heading marker, an HTML tag,
 * or a mark of emphasis, strikethrough, a table or math. A change that adds or removes syntax would cross it.
 */
interface Atom { kind: "space" | "word" | "open" | "close" | "link" | "syntax"; text: string }

/** Past this many atoms added and removed, a block's words share too little to mark: it stays changed as a whole. */
const WORD_EDITS = 200;

/** The kinds of block whose words can be marked: prose, not code, tables, math or HTML. */
const PROSE = new Set(["paragraph", "heading", "listItem", "blockquote"]);

// What a line starts with: its indent, quote markers, and a heading's marker, or a list's with its task box; or the whole
// line, when it underlines a heading.
const UNDERLINE = /[ \t]*(?:=+|-+)[ \t]*(?=\n|$)/y;
const LINE_START = /[ \t]*(?:>[ \t]?)*[ \t]*(?:#{1,6}(?=[ \t\n]|$)|(?:[-*+]|\d{1,9}[.)])(?=[ \t\n]|$)(?:[ \t]+\[[ xX]\](?=[ \t\n]|$))?)?[ \t]*/y;
// A link, inline or by reference, and its words.
const LINK = /\[(?:[^[\]\n\\]|\\.)*\](?:\((?:[^()\n\\]|\\.)*\)|\[[^[\]\n]*\])/y;
const LINK_WORDS = /(?<=^\[)(?:[^[\]\n\\]|\\.)*/;
// The rest of a line, first match first.
const ATOMS: [RegExp, Atom["kind"]][] = [
  [/(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/y, "word"],
  [/!\[(?:[^[\]\n\\]|\\.)*\](?:\((?:[^()\n\\]|\\.)*\)|\[[^[\]\n]*\])/y, "link"],
  [LINK, "open"],
  [/<(?:https?|mailto|ftp):[^\s<>]*>|(?:https?:\/\/|www\.)[^\s<]*[^\s<.,;:!?'")\]]/y, "link"],
  [/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<!--/y, "syntax"],
  [/&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{0,31});|\\[!-/:-@[-`{-~]/y, "word"],
  [/[ \t]*\n|[ \t]+/y, "space"],
  [/[\p{L}\p{N}]+(?:['’_.-][\p{L}\p{N}]+)*/uy, "word"],
  [/[*_~`[\]<|$\\]/y, "syntax"],
  [/\S/uy, "word"],
];

function atomsOf(text: string, lines = true): Atom[] {
  const atoms: Atom[] = [];
  const take = (pattern: RegExp, at: number) => { pattern.lastIndex = at; return pattern.exec(text)?.[0] ?? ""; };
  for (let at = 0; at < text.length;) {
    if (lines && (at === 0 || text[at - 1] === "\n")) {
      const start = take(UNDERLINE, at) || take(LINE_START, at);
      if (start) { atoms.push({ kind: "syntax", text: start }); at += start.length; continue; }
    }
    for (const [pattern, kind] of ATOMS) {
      const found = take(pattern, at);
      if (!found) continue;
      // A link's words are words, between its brackets.
      if (kind === "open") {
        const words = found.match(LINK_WORDS)![0];
        atoms.push({ kind: "open", text: "[" }, ...atomsOf(words, false), { kind: "close", text: found.slice(words.length + 1) });
      } else atoms.push({ kind, text: found });
      at += found.length;
      break;
    }
  }
  return atoms;
}

/**
 * What a syntax tree draws, as a string to compare: each node's type, text and value without whitespace (a mark taken
 * out leaves the spaces around it), URL, reference label and heading depth. Read as one side of marked text, `keep` "ins" drops each `<del>`…`</del>` and the
 * `<ins>` tags, and "del" the reverse.
 */
function drawn(tree: Nodes, keep?: "ins" | "del"): string {
  let dropping = false;
  const walk = (node: Nodes): unknown => {
    if (!("children" in node)) return [node.type, "value" in node ? node.value.replace(/\s+/g, "") : null];
    const children: unknown[] = [];
    let text = "";
    const flush = () => { if (text.trim()) children.push(text.replace(/\s+/g, "")); text = ""; };
    for (const child of node.children) {
      const tag = keep && child.type === "html" ? child.value.match(/^<(\/?)(del|ins)>$/) : null;
      if (tag) { if (tag[2] !== keep) dropping = !tag[1]; continue; }
      if (dropping) continue;
      if (child.type === "text") { text += child.value; continue; }
      flush();
      children.push(walk(child));
    }
    flush();
    return [node.type, "url" in node ? node.url : null, "identifier" in node ? node.identifier : null, "depth" in node ? node.depth : null, children];
  };
  return JSON.stringify(walk(tree));
}

const struck = (node: Nodes): boolean => node.type === "delete" || ("children" in node && node.children.some(struck));

/**
 * Whether `marked` draws as `now` without its deletions, and as `old` without its insertions, and neither has
 * strikethrough, which would read as a mark. The atoms keep marks out of syntax they know; this is the safety net for
 * what they don't, where CommonMark reads raw HTML otherwise: emphasis inside a word (and so in CJK), a shortcut
 * reference's label, a code span over two lines, indented code.
 */
function drawsAsBoth(marked: string, old: string, now: string): boolean {
  const [tree, before, after] = [parseMarkdown(marked), parseMarkdown(old), parseMarkdown(now)];
  return !struck(before) && !struck(after) && drawn(tree, "ins") === drawn(after) && drawn(tree, "del") === drawn(before);
}

const solid = (text: string) => text.replace(/\s/g, "").length;
const join = (atoms: Atom[]) => atoms.map((atom) => atom.text).join("");

/**
 * `now`, a block's new Markdown, with the words that changed from `old` marked as GitHub's rich diff marks them: each
 * change's removed words as `<del>`, then its added ones as `<ins>`. Any two whitespaces are alike, so rewrapped lines
 * mark nothing, and changes a space apart are one. Null when there's nothing to mark, or marking would mislead or break
 * the Markdown: a change that crosses its syntax, changes a link (its words would show twice), shares under
 * `CONFETTI_THRESHOLD` of its text, is too large to diff, or marked, would draw something else (`drawsAsBoth`).
 */
export function markWords(old: string, now: string): string | null {
  // A file's marks are worked out again as it unfolds, or its chapter opens again: the same blocks' are kept, a few hundred.
  const key = `${old}\0${now}`;
  if (marks.has(key)) return marks.get(key)!;
  if (marks.size >= MARKS_KEPT) marks.delete(marks.keys().next().value!);
  const marked = mark(old, now);
  marks.set(key, marked);
  return marked;
}

const MARKS_KEPT = 500;
const marks = new Map<string, string | null>();

function mark(old: string, now: string): string | null {
  const parts = diffArrays(atomsOf(old), atomsOf(now), { comparator: (a, b) => a.text === b.text || a.kind === "space" && b.kind === "space", maxEditLength: WORD_EDITS });
  if (!parts) return null;
  let out = "";
  let kept = 0;
  let marked = false;
  let gone: Atom[] = [];
  let come: Atom[] = [];
  // Emits the change so far: its removed words, a removed line joining the one before, then its added words, each line's
  // own, with the whitespace around each outside its mark.
  const change = (): boolean => {
    if (!gone.length && !come.length) return true;
    if ([...gone, ...come].some((atom) => atom.kind === "syntax") || gone.some((atom) => atom.kind === "link") && come.some((atom) => atom.kind === "link")) return false;
    // A link added or removed whole, its brackets with it, or its words: never one of its brackets alone, as a URL that
    // changed is, which marked would show its words twice.
    const whole = (atoms: Atom[]) => {
      let open = 0;
      for (const atom of atoms) if ((open += atom.kind === "open" ? 1 : atom.kind === "close" ? -1 : 0) < 0) return false;
      return open === 0;
    };
    if (!whole(gone) || !whole(come)) return false;
    const removed = join(gone).replace(/\s+/g, " ");
    if (removed.trim()) {
      out += `${/\s$/.test(out) || !/^\s/.test(removed) ? "" : " "}<del>${removed.trim()}</del>${/\s$/.test(removed) && !come.length ? " " : ""}`;
      marked = true;
    }
    out += join(come).replace(/[^\n]+/g, (line) => {
      const [, before, words, after] = line.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
      if (!words) return line;
      marked = true;
      return `${before}<ins>${words}</ins>${after}`;
    });
    gone = [];
    come = [];
    return true;
  };
  for (const [index, part] of parts.entries()) {
    if (part.removed) gone.push(...part.value);
    else if (part.added) come.push(...part.value);
    // Whitespace between two changes joins them.
    else if ((gone.length || come.length) && index + 1 < parts.length && part.value.every((atom) => atom.kind === "space") && !part.value.some((atom) => atom.text.includes("\n"))) {
      gone.push(...part.value);
      come.push(...part.value);
    } else {
      if (!change()) return null;
      out += join(part.value);
      kept += solid(join(part.value));
    }
  }
  if (!change() || !marked) return null;
  if ((2 * kept) / (solid(old) + solid(now) || 1) < CONFETTI_THRESHOLD) return null;
  return drawsAsBoth(out, old, now) ? out : null;
}

/**
 * A changed block's Markdown to draw, its changed words marked (`markWords`), from `previous`, its version before: both
 * made ready to draw by `prepare` (their images as links, lib/link-images.ts), with the new document's `definitions`,
 * which mark nothing; an ordered
 * list's item numbered as it draws now. Null for a block whose words aren't marked: one that isn't prose, holds code,
 * math, strikethrough or a `<del>` or `<ins>` of its own, or changed kind.
 */
export function blockWords(previous: MarkdownBlock, block: MarkdownBlock, definitions: string, prepare: (markdown: string) => string = linkImages): string | null {
  // Code and math draw their text as written. A <del> or <ins> of the author's would read as a mark.
  const unsafe = (source: string) => /^[ \t>]*(?:```|~~~)|\$\$|<\/?(?:del|ins)\b/im.test(source);
  if (!PROSE.has(block.kind) || previous.kind !== block.kind || previous.depth !== block.depth || unsafe(previous.source) || unsafe(block.source)) return null;
  const drawn = (from: MarkdownBlock) => prepare(blockMarkdown({ ...from, ...(block.list ? { list: block.list } : {}) }, definitions));
  return markWords(drawn(previous), drawn(block));
}

/**
 * A rendered file's HTML links outside its code, which it keeps (lib/link-images.ts): each `<a …>…</a>`'s href as
 * written, `&amp;` as `&`, and its words, an image's as its alt says. In one pass: each tag's `>`, and the `</a>` after
 * it, looked for once, as a pattern that looked from each `<a` to the text's end for its `</a>` took seconds.
 */
export function htmlLinks(markdown: string): { text: string; url: string }[] {
  let prose = "";
  let from = 0;
  for (const [start, end] of codeRanges(markdown, true)) {
    prose += markdown.slice(from, start) + " ".repeat(end - start);
    from = end;
  }
  prose += markdown.slice(from);
  const links: { text: string; url: string }[] = [];
  const [open, close] = [/<a(?=[\s/>])/gi, /<\/a\s*>/gi];
  // The next `</a>`, or null once none is left.
  let closing: RegExpExecArray | null | undefined;
  for (let match; (match = open.exec(prose));) {
    const end = prose.indexOf(">", open.lastIndex);
    if (end < 0) break;
    if (closing === undefined || (closing && closing.index <= end)) {
      close.lastIndex = end + 1;
      closing = close.exec(prose);
    }
    if (!closing) break;
    const href = prose.slice(open.lastIndex, end).match(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    const words = prose.slice(end + 1, closing.index).replace(/<img\b[^<>]*>/gi, (tag) => { const alt = tag.match(/\salt\s*=\s*(?:"([^"]*)"|'([^']*)')/i); return alt ? `Image: ${alt[1] ?? alt[2]}` : "Image"; });
    if (href) links.push({ text: words.replace(/<[^<>]*>/g, "").replace(/\s+/g, " ").trim(), url: (href[1] ?? href[2] ?? href[3]).replace(/&amp;/gi, "&") });
    open.lastIndex = closing.index + closing[0].length;
  }
  return links;
}

/** A link a block keeps, by its words, whose URL changed. */
export interface ChangedLink { text: string; from: string; to: string }

/**
 * The links of `now` whose words `old` has once too, as a link to another URL, inline or by reference to a definition in
 * the text, or an HTML `<a>`: what marking can't show, as its words are the same.
 */
export function changedLinks(old: string, now: string): ChangedLink[] {
  const linksOf = (markdown: string) => {
    const definitions = new Map<string, string>();
    const links: { text: string; url?: string; label?: string }[] = [];
    const textOf = (node: Nodes): string => ("value" in node ? node.value : "children" in node ? node.children.map(textOf).join("") : "");
    const walk = (node: Nodes) => {
      if (node.type === "definition") definitions.set(node.identifier, node.url);
      if (node.type === "link") links.push({ text: textOf(node), url: node.url });
      if (node.type === "linkReference") links.push({ text: textOf(node), label: node.identifier });
      if ("children" in node) node.children.forEach(walk);
    };
    walk(parseMarkdown(markdown));
    links.push(...htmlLinks(markdown));
    // A reference's URL is its definition's, wherever that is in the text.
    return links.map(({ text, url, label }) => ({ text, url: url ?? definitions.get(label!) }));
  };
  const [before, after] = [linksOf(old), linksOf(now)];
  const once = (links: { text: string }[], text: string) => links.filter((link) => link.text === text).length === 1;
  return after.flatMap(({ text, url }) => {
    const was = before.find((link) => link.text === text);
    return was && url !== undefined && was.url !== undefined && was.url !== url && once(before, text) && once(after, text) ? [{ text, from: was.url, to: url }] : [];
  });
}
