// GitHub shows the images in its comments through its own proxy. BB's Markdown would load them from wherever they point,
// telling that server who read the text and when. So the text of others and of agents shows each image as a link to
// it, and its HTML as text but for a few formatting tags: rewriting each tag that loads something always missed one.

/**
 * `markdown` as it's safe to show from others and agents. Each image becomes a link to it, `[Image: alt](url)` or
 * `[Image](url)`, so nothing loads until it's clicked: inline and reference images, and HTML `<img>`, `<video>` and
 * `<source>`. An image inside a link's text becomes its words, the link kept. HTML comments are hidden, as GitHub hides
 * them. Then every `<` that doesn't begin one of the FORMATTING tags, or an autolink, shows as text. Code spans and
 * fenced code stay as written where the Markdown around them leaves no doubt they're code (`structure`); elsewhere
 * code is changed too.
 */
export function linkImages(markdown: string): string {
  if (!/<|!\[/.test(markdown)) return markdown;
  const text = markdown.replace(/\r\n?/g, "\n");
  const labels = new Set([...text.matchAll(/^ {0,3}\[([^\]\n]+)\]:/gm)].map((match) => normalLabel(match[1])));
  return escapeHtml(outsideCode(text, (prose) => withoutComments(linkMarkdownImages(linkHtmlMedia(prose), labels))));
}

/**
 * `text` without its complete HTML comments: a PR template's or a bot's hidden notes. What's left is judged after, so
 * a tag the removal joins, as `<im<!-- -->g`, shows as text; an unclosed `<!--` shows too.
 */
const withoutComments = (text: string) => text.replace(/<!--(?:-?>|[\s\S]*?-->)/g, "");

const normalLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();
const imageLabel = (alt: string) => alt.trim() ? `Image: ${alt.trim()}` : "Image";

/** `text` and then `link`: a `!` ending the text is escaped, so that with a link's `[` it isn't an image. */
const thenLink = (text: string, link: string) => link.startsWith("[") && /(^|[^\\])(\\\\)*!$/.test(text) ? `${text.slice(0, -1)}\\!${link}` : text + link;

/**
 * Each `<img>`, `<video>` and `<source>` in `text` as links to what it would load, the media BB's HTML allows. A video
 * is replaced even without a url, so the links of its `<source>`s show rather than sit in a player as fallback.
 */
function linkHtmlMedia(text: string): string {
  let out = "";
  let from = 0;
  for (const { 0: tag, 1: name, index } of text.matchAll(/<(img|video|source)\b[^>]*>/gi)) {
    out = thenLink(out + text.slice(from, index), htmlMediaLink(name.toLowerCase(), tag));
    from = index + tag.length;
  }
  return out + text.slice(from);
}

/**
 * `<img … src="url" alt="…">` as a link to its url, one without a url as its words alone; `<video>` as links to its
 * src and poster, or its word; `<source>` as a link to its src or srcset's first url, or nothing.
 */
function htmlMediaLink(name: string, tag: string): string {
  const attribute = (attributeName: string) => {
    const match = new RegExp(`\\s${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
    return match ? (match[1] ?? match[2] ?? match[3]).replace(/&amp;/g, "&") : "";
  };
  const link = (label: string, url: string) => `[${label}](${destination(url)})`;
  const src = attribute("src") || attribute("srcset").trim().split(/\s+/)[0] || "";
  if (name === "source") return src && link("Media", src);
  if (name === "video") {
    const title = attribute("title").replace(/[[\]]/g, "").trim();
    const label = title ? `Video: ${title}` : "Video";
    const poster = attribute("poster");
    return [src && link(label, src), poster && link(src ? "Poster" : `${label} poster`, poster)].filter(Boolean).join(" ") || label;
  }
  const label = imageLabel(attribute("alt").replace(/[[\]]/g, ""));
  return src ? link(label, src) : label;
}

/** A url as a link's destination, in angle brackets when it has spaces or parentheses. */
const destination = (url: string) => /[\s()<>]/.test(url) ? `<${url.replace(/[<>\n]/g, encodeURIComponent)}>` : url;

/** The index just past the `]` that closes the `[` at `open`, or -1. */
function closeBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * `![alt](url)` and `![alt][ref]` as `[Image: alt](url)` and `[Image: alt][ref]`; `![alt][]` and `![alt]`, whose label
 * is the alt, keep it as the reference. Inside a link's text, where a link can't go, an image is its words. Any other
 * `![`, as one whose definition sits in a quote or a list, has its `!` escaped: at most a link, never an image.
 */
function linkMarkdownImages(text: string, labels: Set<string>): string {
  let out = "";
  let from = 0;
  // `[`s still open: an image after one is inside what may be a link's text.
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") { i++; continue; }
    if (char === "]" && open) { open--; continue; }
    if (char === "[") { open++; continue; }
    if (char !== "!" || text[i + 1] !== "[") continue;
    const end = closeBracket(text, i + 1);
    if (end < 0) { out += text.slice(from, i) + "\\!"; from = i + 1; continue; }
    const alt = text.slice(i + 2, end - 1);
    const label = imageLabel(linkMarkdownImages(alt, labels).replace(/[[\]]/g, ""));
    const next = text[end];
    let replaced: string | null = null;
    let after = end;
    if (next === "(") {
      after = closeParen(text, end);
      if (after > 0) replaced = open ? label : `[${label}]${text.slice(end, after)}`;
    } else if (next === "[") {
      after = closeBracket(text, end);
      const ref = after > 0 ? text.slice(end + 1, after - 1) : "";
      if (after > 0) replaced = open ? label : `[${label}][${ref.trim() ? ref : alt}]`;
    } else if (labels.has(normalLabel(alt))) {
      replaced = open ? label : `[${label}][${alt}]`;
    }
    if (replaced === null) { out += text.slice(from, i) + "\\!"; from = i + 1; continue; }
    out = thenLink(out + text.slice(from, i), replaced);
    from = after;
    i = after - 1;
  }
  return out + text.slice(from);
}

/** The index just past the `)` that closes the `(` at `open`, skipping a `<…>` destination and quoted title; or -1. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") { i++; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "<" && depth === 1) { const close = text.indexOf(">", i); if (close > 0) { i = close; continue; } }
    if ((char === '"' || char === "'") && depth === 1 && /\s/.test(text[i - 1])) { quote = char; continue; }
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i + 1;
    else if (char === "\n" && text[i + 1] === "\n") return -1;
  }
  return -1;
}

/**
 * The HTML that others' and agents' text may use, with the attributes each may have: tags that only format, none
 * with a url or anything else that loads. Anything else shows as text.
 */
const FORMATTING = new Map<string, readonly string[]>([
  ...["b", "i", "em", "strong", "code", "kbd", "sub", "sup", "s", "del", "ins", "br", "hr", "pre", "summary", "blockquote", "ul", "thead", "tbody"].map((name) => [name, []] as const),
  ...["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr"].map((name) => [name, ["align"]] as const),
  ["details", ["open"]], ["ol", ["start", "type", "reversed"]], ["li", ["value"]],
  ["th", ["align", "colspan", "rowspan"]], ["td", ["align", "colspan", "rowspan"]],
]);
// The FORMATTING tags that begin an HTML block that interrupts a paragraph and ends at a blank line (CommonMark's 6th).
const BLOCK_TAGS = new Set(["details", "summary", "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "hr", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td"]);

/**
 * The FORMATTING tag at `at` in `text`, open or closing: on one line, each attribute one its tag allows, with a value
 * free of quotes, `<`, `>` and backticks, so CommonMark and an HTML parser read it alike and it holds no code span's
 * backtick.
 */
function formattingTag(text: string, at: number): { name: string; close: boolean; end: number } | null {
  const head = /<(\/?)([A-Za-z][A-Za-z0-9]*)/y;
  head.lastIndex = at;
  const match = head.exec(text);
  const allowed = match && FORMATTING.get(match[2].toLowerCase());
  if (!match || !allowed) return null;
  const name = match[2].toLowerCase();
  let end = head.lastIndex;
  if (!match[1]) {
    const attribute = /[ \t]+([A-Za-z][A-Za-z0-9-]*)(?:[ \t]*=[ \t]*(?:"[^"'<>`\n]*"|'[^"'<>`\n]*'|[^\s"'=<>`]+))?/y;
    for (let found; (attribute.lastIndex = end, found = attribute.exec(text));) {
      if (!allowed.includes(found[1].toLowerCase())) return null;
      end = attribute.lastIndex;
    }
  }
  const close = match[1] ? /[ \t]*>/y : /[ \t]*\/?>/y;
  close.lastIndex = end;
  return close.exec(text) ? { name, close: !!match[1], end: close.lastIndex } : null;
}

/** A url or email autolink, or a link destination in angle brackets with a scheme: neither is ever an HTML tag. */
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\n`]*|[A-Za-z0-9.!#$%&'*+/=?^_{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;

/**
 * The end of what the `<` at `at` begins that's left as written: a FORMATTING tag, or on an inline line an autolink
 * (in an HTML block it would be a tag); or -1.
 */
function keptEnd(text: string, at: number, inline: boolean): number {
  const tag = formattingTag(text, at);
  if (tag) return tag.end;
  AUTOLINK.lastIndex = at;
  return inline && AUTOLINK.test(text) ? AUTOLINK.lastIndex : -1;
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;

/**
 * `text` with every `<` outside code that isn't kept (`keptEnd`) as `&lt;`, and any `![` left outside code as `\![`.
 * Each `<` is judged in `text` as given, so escaping one can't make a tag of what's around it. On inline text `\<`
 * is `&lt;` too: it shows the same, and is text still if BB reads the line as HTML.
 */
function escapeHtml(text: string): string {
  const { lines, spans } = structure(text);
  let out = "";
  let span = 0;
  for (const { start, end, kind } of lines) {
    if (kind === "fence") out += text.slice(start, end);
    else for (let i = start; i < end;) {
      const char = text[i];
      if (span < spans.length && spans[span][0] === i) {
        out += text.slice(i, spans[span][1]);
        i = spans[span++][1];
      } else if (char === "\\" && text[i + 1] === "<" && kind === "inline") {
        out += "&lt;";
        i += 2;
      } else if (char === "\\" && PUNCTUATION.test(text[i + 1] ?? "") && text[i + 1] !== "<") {
        out += text.slice(i, i + 2);
        i += 2;
      } else if (char === "<") {
        const kept = keptEnd(text, i, kind === "inline");
        out += kept > 0 ? text.slice(i, kept) : "&lt;";
        i = kept > 0 ? kept : i + 1;
      } else {
        out += char === "!" && text[i + 1] === "[" ? "\\!" : char;
        i++;
      }
    }
    if (end < text.length) out += "\n";
  }
  return out;
}

/** Where `markdown`'s code is, as linkImages reads it: the lines of its fenced code, and its code spans, in order. */
export function codeRanges(markdown: string): Array<readonly [number, number]> {
  const { lines, spans } = structure(markdown);
  return [...lines.filter((line) => line.kind === "fence").map(({ start, end }) => [start, end] as const), ...spans].sort((a, b) => a[0] - b[0]);
}

/** `text` with `change` made to each stretch between its code. */
function outsideCode(text: string, change: (prose: string) => string): string {
  let out = "";
  let from = 0;
  for (const [start, end] of codeRanges(text)) {
    out += change(text.slice(from, start)) + text.slice(start, end);
    from = end;
  }
  return out + change(text.slice(from));
}

type LineKind = "fence" | "inline" | "raw";
interface Line { start: number; end: number; kind: LineKind }

/**
 * Each line of `text` as CommonMark with GFM reads it once `escapeHtml` has run, so only FORMATTING tags can begin an
 * HTML block: a fenced code block's, inline text (a paragraph's or a heading's), or anything else; and the code spans
 * in inline text. See `lineKinds` and `codeSpans`.
 */
function structure(text: string): { lines: Line[]; spans: Array<[number, number]> } {
  const rows = text.split("\n");
  const kinds = lineKinds(rows);
  const lines: Line[] = [];
  let start = 0;
  rows.forEach((row, index) => {
    lines.push({ start, end: start + row.length, kind: kinds[index] });
    start += row.length + 1;
  });
  return { lines, spans: codeSpans(text, lines) };
}

type Container = { quote: true } | { quote: false; offset: number; filled: boolean };
type Leaf =
  | { kind: "paragraph"; first: number; definition: boolean; table: boolean }
  | { kind: "fence"; char: string; length: number }
  | { kind: "html"; pre: boolean }
  | { kind: "indented" };

const blank = (text: string) => /^[ \t]*$/.test(text);
const spaces = (text: string, at = 0) => /^ */.exec(text.slice(at))![0].length;

/**
 * Each row's kind, following CommonMark's block quotes, list items, lazy lines, fences, HTML blocks and paragraphs.
 * Where a reading is in doubt, every row from there on is raw, so nothing after it is kept as code: a tab in an
 * indent; front matter, a math block (`$$`), a directive (`:::`) or a GFM footnote definition (`[^`), whose indented
 * rows are its blocks; a lone tag after a paragraph's line; a fence or HTML block that a row outside its quote or list
 * item ends; a table, or a paragraph that may be a link definition, that a block interrupts or a lazy row continues.
 * Readers other than CommonMark's, or GFM's, may read those otherwise.
 */
function lineKinds(rows: string[]): LineKind[] {
  const kinds = rows.map((): LineKind => "raw");
  const stack: Container[] = [];
  let leaf: Leaf | null = null;
  const fill = () => { for (const container of stack) if (!container.quote) container.filled = true; };

  const read = (row: string, index: number): LineKind | null => {
    let pos = 0;
    let matched = 0;
    for (; matched < stack.length; matched++) {
      const container = stack[matched];
      const indent = spaces(row, pos);
      if (container.quote) {
        if (indent <= 3 && row[pos + indent] === "\t") return null;
        if (indent > 3 || row[pos + indent] !== ">") break;
        pos += indent + 1;
        if (row[pos] === "\t") return null;
        if (row[pos] === " ") pos++;
      } else if (blank(row.slice(pos))) {
        if (!container.filled) break;
      } else if (indent >= container.offset) pos += container.offset;
      else if (row[pos + indent] === "\t") return null;
      else break;
    }
    const all = matched === stack.length;
    // CommonMark ends a fence or HTML block with the quote or list item it's in; marked, and maybe others, goes on.
    if (!all && (leaf?.kind === "fence" || leaf?.kind === "html") && !blank(row)) return null;
    if (all && leaf?.kind === "fence") {
      const rest = row.slice(pos);
      if (stack.length && /^ {0,3}\t/.test(rest)) return null;
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(rest);
      if (close && close[1][0] === leaf.char && close[1].length >= leaf.length) leaf = null;
      return "fence";
    }
    if (all && leaf?.kind === "html") {
      if (leaf.pre ? /<\/pre>/i.test(row.slice(pos)) : blank(row.slice(pos))) leaf = null;
      return "raw";
    }
    if (all && leaf?.kind === "indented") {
      const rest = row.slice(pos);
      if (blank(rest) || spaces(rest) >= 4) return "raw";
      if (rest[spaces(rest)] === "\t") return null;
      leaf = null;
    }
    const paragraph = leaf?.kind === "paragraph" ? leaf : null;
    // CommonMark's "the line's container is a paragraph": a setext underline, or a list item that can't interrupt it.
    let matchedParagraph = all && !!paragraph;
    let opened = false;
    let closed = false;
    // Closes the blocks this row didn't match, and the open leaf, for a new block; false when that's in doubt.
    const close = () => {
      if (closed) return true;
      if (paragraph && (paragraph.definition || paragraph.table)) return false;
      stack.length = matched;
      leaf = null;
      return (closed = true);
    };
    const open = (container: Container) => {
      stack.push(container);
      matched = stack.length;
      opened = true;
      matchedParagraph = false;
    };
    for (;;) {
      const rest = row.slice(pos);
      if (blank(rest)) break;
      const indent = spaces(rest);
      if (indent < 4 && rest[indent] === "\t") return null;
      const tail = rest.slice(indent);
      // CommonMark's "the tip is a paragraph": this row can go on with it, lazily too.
      const continues = !!paragraph && !opened;
      if (indent >= 4) {
        if (continues) break;
        if (!close()) return null;
        leaf = { kind: "indented" };
        return "raw";
      }
      if (/^(?:\$\$|:::|\[\^)/.test(tail)) return null;
      if (tail[0] === ">") {
        if (!close()) return null;
        pos += indent + 1;
        if (row[pos] === "\t") return null;
        if (row[pos] === " ") pos++;
        open({ quote: true });
        continue;
      }
      if (/^#{1,6}(?:[ \t]|$)/.test(tail)) {
        if (!close()) return null;
        fill();
        return "inline";
      }
      const fence = /^(?:`{3,}(?!.*`)|~{3,})/.exec(tail);
      if (fence) {
        if (!close()) return null;
        leaf = { kind: "fence", char: fence[0][0], length: fence[0].length };
        fill();
        return "fence";
      }
      const html = htmlBlock(tail);
      // CommonMark goes on with the paragraph; marked, and maybe others, starts an HTML block.
      if (html === 7 && continues) return null;
      if (html && (html !== 7 || !continues)) {
        if (!close()) return null;
        if (html !== 1 || !/<\/pre>/i.test(tail.slice(1))) leaf = { kind: "html", pre: html === 1 };
        fill();
        return "raw";
      }
      // A GFM delimiter row has a pipe or a colon (`a\n:-:` is a table of one column); without, a setext underline.
      const delimiter = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(tail) && (/[|:]/.test(tail) || !!rows[index - 1]?.includes("|"));
      if (delimiter && continues && !all) return null;
      if (delimiter && matchedParagraph && !/^[-+*][ \t]/.test(tail)) {
        paragraph!.table = true;
        for (let n = paragraph!.first; n < index; n++) kinds[n] = "raw";
        return "raw";
      }
      if (matchedParagraph && /^(?:=+|-+)[ \t]*$/.test(tail)) return close() ? "raw" : null;
      if (/^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(tail)) return close() ? "raw" : null;
      const item = /^(?:[-+*]|(\d{1,9})[.)])(?=[ \t]|$)/.exec(tail);
      if (item) {
        const after = tail.slice(item[0].length);
        if (after[0] === "\t") return null;
        const empty = blank(after);
        // micromark lets an ordered item interrupt a paragraph only from 1 itself, not 01.
        if (!(matchedParagraph && (empty || (item[1] !== undefined && item[1] !== "1")))) {
          if (!close()) return null;
          const gap = spaces(after);
          const padding = empty || gap >= 5 ? 1 : gap;
          pos += indent + item[0].length + (empty ? gap : padding);
          open({ quote: false, offset: indent + item[0].length + padding, filled: !empty });
          continue;
        }
      }
      break;
    }
    if (blank(row.slice(pos))) {
      if (!closed) stack.length = matched;
      leaf = null;
      return "raw";
    }
    if (paragraph && !opened) {
      if (!all && (paragraph.definition || paragraph.table)) return null;
      if (all) fill();
      return paragraph.table ? "raw" : "inline";
    }
    if (!close()) return null;
    leaf = { kind: "paragraph", first: index, definition: mayDefine(row.slice(pos).trimStart()), table: false };
    fill();
    return "inline";
  };

  if (/^(?:---|\+\+\+)[ \t]*$/.test(rows[0])) return kinds;
  for (let index = 0; index < rows.length; index++) {
    const kind = read(rows[index], index);
    if (!kind) return kinds.fill("raw", index);
    kinds[index] = kind;
  }
  return kinds;
}

/** Whether a paragraph beginning `text` can be a link definition: `[label]:`, or a label going on past its line. */
function mayDefine(text: string): boolean {
  const label = /^\[(?:[^\]\\]|\\.)*\]/.exec(text);
  return text[0] === "[" && (!label || text[label[0].length] === ":");
}

/** The CommonMark HTML block (1, 6 or 7) that `text`, a row from its indent, begins once `escapeHtml` has run, or 0. */
function htmlBlock(text: string): 0 | 1 | 6 | 7 {
  const tag = text[0] === "<" ? formattingTag(text, 0) : null;
  if (!tag) return 0;
  if (!tag.close && tag.name === "pre" && text[4] !== "/") return 1;
  if (BLOCK_TAGS.has(tag.name)) return 6;
  return blank(text.slice(tag.end)) ? 7 : 0;
}

/**
 * The code spans CommonMark finds in inline `lines`, read as `escapeHtml` leaves them. Backticks pair within a line;
 * within a run of lines between blank lines and fences, once a backtick may go uncounted (one no line closes, or one a
 * GFM autolink literal, math, a directive, a link's destination or title, a reference or a definition may hold), the
 * run's later backticks are text. Math begins at `$$`: BB reads no single `$` as math.
 */
function codeSpans(text: string, lines: Line[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let paired = true;
  for (const { start, end, kind } of lines) {
    const line = text.slice(start, end);
    if (kind === "fence" || blank(line)) {
      paired = true;
      continue;
    }
    // Where the word at `i` begins: an autolink literal runs to a space.
    let word = 0;
    for (let i = 0; paired && i < line.length;) {
      const char = line[i];
      const next = line[i + 1] ?? "";
      if (char === "\\" && PUNCTUATION.test(next)) i += 2;
      else if (char === " " || char === "\t") word = ++i;
      else if (char === "<") {
        const kept = keptEnd(line, i, kind === "inline");
        i = kept > 0 ? (word = kept) : i + 1;
      } else if (char === "`") {
        const length = /^`+/.exec(line.slice(i))![0].length;
        const close = closingRun(line, i + length, length);
        if (close < 0 || /[:@]|www\./i.test(line.slice(word, i))) paired = false;
        else {
          if (kind === "inline") spans.push([start + i, start + close + length]);
          i = word = close + length;
        }
      } else if ((char === "$" && next === "$") || (char === ":" && /[A-Za-z]/.test(next))) paired = false;
      else if (char === "]" && (next === ":" || (next === "(" && !simpleResource(line, i + 1)) || (next === "[" && !/^\[[^[\]\\`\n]*\]/.test(line.slice(i + 1))))) paired = false;
      else i++;
    }
  }
  return spans;
}

/** Where the next run of exactly `length` backticks from `from` in `line` begins, or -1. */
function closingRun(line: string, from: number, length: number): number {
  for (const run of line.slice(from).matchAll(/`+/g)) if (run[0].length === length) return from + run.index;
  return -1;
}

/** Whether the `(` at `at` in `line` begins a link's destination and title that close on the line, with no backtick or backslash. */
function simpleResource(line: string, at: number): boolean {
  return /^\((?:[ \t]*(?:<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\n`\\]*>|(?:[^\s()<>`\\]|\([^\s()<>`\\]*\))+))?(?:[ \t]+(?:"[^"\n`\\]*"|'[^'\n`\\]*'|\([^()\n`\\]*\)))?[ \t]*\)/.test(line.slice(at));
}
