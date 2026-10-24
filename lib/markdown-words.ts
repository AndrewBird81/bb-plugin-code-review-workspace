import { diffArrays } from "diff";
import { CONFETTI_THRESHOLD } from "./confetti";
import { linkImages } from "./link-images";
import type { Nodes } from "mdast";
import { blockMarkdown, parseMarkdown, type MarkdownBlock } from "./markdown-blocks";

/**
 * A piece of a block's Markdown that changes whole: a run of whitespace, a word or a mark of punctuation, a code span, a
 * link (`link`), or Markdown's syntax (`syntax`): a line's list marker, task box, quote or heading marker, an HTML tag, or
 * a mark of emphasis, strikethrough, a table or math. A change that adds or removes syntax would cross it.
 */
interface Atom { kind: "space" | "word" | "link" | "syntax"; text: string }

/** Past this many atoms added and removed, a block's words share too little to mark: it stays changed as a whole. */
const WORD_EDITS = 200;

/** The kinds of block whose words can be marked: prose, not code, tables, math or HTML. */
const PROSE = new Set(["paragraph", "heading", "listItem", "blockquote"]);

// What a line starts with: its indent, quote markers, and a heading's marker, or a list's with its task box; or the whole
// line, when it underlines a heading.
const UNDERLINE = /[ \t]*(?:=+|-+)[ \t]*(?=\n|$)/y;
const LINE_START = /[ \t]*(?:>[ \t]?)*[ \t]*(?:#{1,6}(?=[ \t\n]|$)|(?:[-*+]|\d{1,9}[.)])(?=[ \t\n]|$)(?:[ \t]+\[[ xX]\](?=[ \t\n]|$))?)?[ \t]*/y;
// The rest of a line, first match first.
const ATOMS: [RegExp, Atom["kind"]][] = [
  [/(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/y, "word"],
  [/!?\[(?:[^[\]\n\\]|\\.)*\](?:\((?:[^()\n\\]|\\.)*\)|\[[^[\]\n]*\])/y, "link"],
  [/<(?:https?|mailto|ftp):[^\s<>]*>|(?:https?:\/\/|www\.)[^\s<]*[^\s<.,;:!?'")\]]/y, "link"],
  [/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<!--/y, "syntax"],
  [/&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{0,31});|\\[!-/:-@[-`{-~]/y, "word"],
  [/[ \t]*\n|[ \t]+/y, "space"],
  [/[\p{L}\p{N}]+(?:['’_.-][\p{L}\p{N}]+)*/uy, "word"],
  [/[*_~`[\]<|$\\]/y, "syntax"],
  [/\S/uy, "word"],
];

function atomsOf(text: string): Atom[] {
  const atoms: Atom[] = [];
  const take = (pattern: RegExp, at: number) => { pattern.lastIndex = at; return pattern.exec(text)?.[0] ?? ""; };
  for (let at = 0; at < text.length;) {
    if (at === 0 || text[at - 1] === "\n") {
      const start = take(UNDERLINE, at) || take(LINE_START, at);
      if (start) { atoms.push({ kind: "syntax", text: start }); at += start.length; continue; }
    }
    for (const [pattern, kind] of ATOMS) {
      const found = take(pattern, at);
      if (!found) continue;
      atoms.push({ kind, text: found });
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
 * with their images as links (lib/link-images.ts) and the new document's `definitions`, which mark nothing; an ordered
 * list's item numbered as it draws now. Null for a block whose words aren't marked: one that isn't prose, holds code,
 * math, strikethrough or a `<del>` or `<ins>` of its own, or changed kind.
 */
export function blockWords(previous: MarkdownBlock, block: MarkdownBlock, definitions: string): string | null {
  // Code and math draw their text as written. A <del> or <ins> of the author's would read as a mark.
  const unsafe = (source: string) => /^[ \t>]*(?:```|~~~)|\$\$|<\/?(?:del|ins)\b/im.test(source);
  if (!PROSE.has(block.kind) || previous.kind !== block.kind || previous.depth !== block.depth || unsafe(previous.source) || unsafe(block.source)) return null;
  const drawn = (from: MarkdownBlock) => linkImages(blockMarkdown({ ...from, ...(block.list ? { list: block.list } : {}) }, definitions));
  return markWords(drawn(previous), drawn(block));
}
