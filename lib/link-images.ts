import type { Nodes } from "mdast";
import { parseMarkdown } from "./markdown-blocks";

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
 *
 * With `links`, as for a file the review renders, its own HTML links stay links: each `<a>` keeps its href alone, where
 * `anchorHref` keeps one, and an HTML image or video is an `<a>` to it, which draws inside an HTML block as a Markdown
 * link wouldn't. Nothing loads still, and the comments of others and agents never take `links`.
 */
export function linkImages(markdown: string, links?: HtmlLinks): string {
  if (!/<|!\[/.test(markdown)) return markdown;
  // BB's Markdown drops one leading byte order mark, so what follows it may begin an HTML block. The text is read
  // without it, and it's kept, so that BB drops it and not a second one.
  const mark = markdown.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = markdown.slice(mark.length).replace(/\r\n?/g, "\n");
  const labels = new Set([...text.matchAll(/^ {0,3}\[([^\]\n]+)\]:/gm)].map((match) => normalLabel(match[1])));
  return mark + escapeHtml(outsideCode(text, (prose) => withoutComments(linkMarkdownImages(linkHtmlMedia(prose, links), labels)), !!links), links);
}

const REPO = "https://repository.invalid/";

/** Where a file's relative links go: a tree on GitHub (`root`, a commit's blob URL) and the file's path in it. */
export interface LinkTree { root: string; path: string }

/** A rendered file's own links kept (`linkImages`), its relative ones to their files in `tree`, or, without one, none. */
export interface HtmlLinks { tree: LinkTree | null }

/**
 * `url`, relative, as the file it names in `tree`, as GitHub's rich diff resolves it: a path from the file's folder, or
 * from the root with a leading `/`, never above it; a query or fragment alone, the file itself.
 */
function inTree(url: string, tree: LinkTree): string {
  // From the file, each part of its path encoded, so a folder named C# is one; on a host of its own, so ../ stops at the
  // repository's root, as a root-relative /path does.
  const file = new URL(tree.path.split("/").map(encodeURIComponent).join("/"), REPO);
  return tree.root + new URL(url, file).href.slice(REPO.length);
}

/** What a rendered file's `<a>` may link to: the web, and email. */
const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * `value`, an `<a>`'s href in a rendered file, as the link it keeps, or null for none: an http, https or mailto URL, or
 * a relative one as the file it names in `tree` (none without one, where it would open a page of BB's own). Read as a
 * browser reads it once `&amp;` is `&`: any other character reference stays as written, so none spells a scheme. A
 * user and password are dropped, as `https://github.com@evil.test` hides its host behind one. Written with nothing an
 * attribute, Markdown or `resolveLinks` reads otherwise: `&` as `&amp;`, and quotes, parentheses, brackets, backticks
 * and spaces percent-encoded.
 */
function anchorHref(value: string, tree: LinkTree | null): string | null {
  // As a URL parser takes it: without tabs or line breaks anywhere, nor controls or spaces at either end, trimmed by
  // hand, as a pattern's trailing trim retried each space of a long run inside it.
  const unbroken = value.replace(/&amp;/gi, "&").replace(/[\t\n\r]/g, "");
  let [from, to] = [0, unbroken.length];
  while (from < to && unbroken.charCodeAt(from) <= 0x20) from++;
  while (to > from && unbroken.charCodeAt(to - 1) <= 0x20) to--;
  const raw = unbroken.slice(from, to);
  // A protocol-relative URL would take BB's own protocol: few files write one.
  if (!raw || /^[\\/]{2}/.test(raw)) return null;
  let url: URL;
  try {
    if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(raw)) url = new URL(raw);
    else if (tree) url = new URL(inTree(raw, tree));
    else return null;
  } catch { return null; }
  if (!LINK_SCHEMES.has(url.protocol)) return null;
  url.username = "";
  url.password = "";
  // The origin as the parser wrote it, an IPv6 host's brackets too; the rest of its ASCII, made plain.
  const head = url.protocol === "mailto:" ? url.protocol : url.origin;
  return head + url.href.slice(head.length).replace(/[^\w\-.~:/?#@!$&*+,;=%]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).replace(/&/g, "&amp;");
}

/**
 * The `<a>` or `</a>` at `start` in a rendered file's text, as `links` keeps it: with its href alone, where `anchorHref`
 * keeps one, else none, so it draws as its words. Null for any other tag.
 */
function linkTag(text: string, start: number, links: HtmlLinks): string | null {
  const tag = formattingTag(text, start, true);
  if (tag?.name !== "a") return null;
  if (tag.close) return "</a>";
  const href = tag.href === undefined ? null : anchorHref(tag.href, links.tree);
  return href ? `<a href="${href}">` : "<a>";
}

/**
 * `markdown` with its relative links' URLs, inline and in its link definitions (as the parser reads them, never a line
 * that only looks like one, or a footnote's), made the files they name in `tree`, as GitHub's rich diff resolves them: a
 * path from the file's folder, or from the root with a leading `/`, never above it; a query or fragment alone, the file
 * itself. A URL with a scheme, or `//`, stays, as does anything in code. Run after `linkImages`, so an image is already a
 * link. Known gap: `linkImages` escapes the `<` of an angle-bracketed destination, `[a](<my file.md>)`, first.
 */
export function resolveLinks(markdown: string, tree: LinkTree): string {
  // A URL with a scheme, or one the URL parser reads as a host, as `//host` or `\\host`, stays, as does one it can't read.
  const resolve = (url: string) => {
    if (/^(?:[a-z][a-z\d+.-]*:|[\\/]{2})/i.test(url)) return url;
    try { return inTree(url, tree); } catch { return url; }
  };
  const destination = (url: string) => (url.startsWith("<") ? `<${resolve(url.slice(1, -1))}>` : resolve(url));
  // Definitions first, by their places, from the last: each one's destination follows its label.
  let text = markdown;
  const definitions: { start: number; end: number }[] = [];
  const walk = (node: Nodes) => {
    if (node.type === "definition" && node.position) definitions.push({ start: node.position.start.offset!, end: node.position.end.offset! });
    if ("children" in node) node.children.forEach(walk);
  };
  walk(parseMarkdown(markdown));
  for (const { start, end } of definitions.reverse()) {
    text = text.slice(0, start) + text.slice(start, end).replace(/^(\s*\[(?:[^\]\\]|\\.)+\]:\s*)(<[^<>\n]*>|\S+)/, (_all, label: string, url: string) => label + destination(url)) + text.slice(end);
  }
  // Read as linkImages left it, with a rendered file's links, where each `<` left is a kept tag or an autolink, all of
  // it on its line: they stay as written, so an attribute's `](` isn't a link's, whose quote would go into its URL.
  return outsideCode(text, (prose) => prose.replace(/<[^<>\n]*>|(\]\(\s*)(<[^<>\n]*>|[^\s()<>]+)/g, (all, before?: string, url?: string) => (before === undefined ? all : before + destination(url!))), true);
}

/**
 * `text` without its complete HTML comments: a PR template's or a bot's hidden notes. What's left is judged after, so
 * a tag the removal joins, as `<im<!-- -->g`, shows as text; an unclosed `<!--` shows too.
 */
function withoutComments(text: string): string {
  let out = "";
  let from = 0;
  // Once no `-->` follows one `<!--`, none follows a later one: looking again from each was quadratic.
  let unclosed = false;
  for (let at = text.indexOf("<!--"); at >= 0; at = text.indexOf("<!--", at + 1)) {
    let end = text[at + 4] === ">" ? at + 5 : text.startsWith("->", at + 4) ? at + 6 : -1;
    if (end < 0 && !unclosed) {
      const close = text.indexOf("-->", at + 4);
      unclosed = close < 0;
      if (close >= 0) end = close + 3;
    }
    if (end < 0) continue;
    out += text.slice(from, at);
    from = end;
    at = end - 1;
  }
  return out + text.slice(from);
}

const normalLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();
const imageLabel = (alt: string) => alt.trim() ? `Image: ${alt.trim()}` : "Image";

/**
 * `link` added to `parts`, the text before it: a `!` ending that text is escaped, so that with a link's `[` it isn't an
 * image. Only the parts' ends are read: reading the end of one string built up piece by piece copies all of it.
 */
function pushLink(parts: string[], link: string): void {
  if (link.startsWith("[") && endsInBang(parts)) parts[parts.length - 1] = `${parts[parts.length - 1].slice(0, -1)}\\!`;
  if (link) parts.push(link);
}

/** Whether `parts`, none of them empty, end in a `!` that no `\` escapes. */
function endsInBang(parts: string[]): boolean {
  let part = parts.length - 1;
  if (part < 0 || !parts[part].endsWith("!")) return false;
  let at = parts[part].length - 1;
  let escaped = false;
  for (;;) {
    while (--at < 0) {
      if (--part < 0) return !escaped;
      at = parts[part].length;
    }
    if (parts[part][at] !== "\\") return !escaped;
    escaped = !escaped;
  }
}

/**
 * Each `<img>`, `<video>` and `<source>` in `text` as links to what it would load, the media BB's HTML allows. A video
 * is replaced even without a url, so the links of its `<source>`s show rather than sit in a player as fallback. With
 * `links`, a `<picture>` is its `<img>` alone, its `<source>`s the same image again; and media inside an `<a>` are
 * their words, as a link can't hold one.
 */
function linkHtmlMedia(text: string, links?: HtmlLinks): string {
  const parts: string[] = [];
  let from = 0;
  const head = links ? /<(\/?picture|img|video|source)\b/gi : /<(img|video|source)\b/gi;
  // The <picture>s and <a>s open, by their tags so far: read once, up to `read`.
  let [picture, link, read] = [0, 0, 0];
  for (let match; (match = head.exec(text));) {
    // A tag runs to the first `>`; when none follows, no later tag closes either.
    const close = text.indexOf(">", head.lastIndex);
    if (close < 0) break;
    if (links) for (const [, end] of text.slice(read, match.index).matchAll(/<(\/?)a(?=[\s/>])/gi)) link = Math.max(link + (end ? -1 : 1), 0);
    read = close + 1;
    if (match.index > from) parts.push(text.slice(from, match.index));
    const name = match[1].toLowerCase();
    if (name.endsWith("picture")) picture = Math.max(picture + (name === "picture" ? 1 : -1), 0);
    else if (!picture || name !== "source") pushLink(parts, htmlMediaLink(name, text.slice(match.index, close + 1), links, link > 0));
    from = head.lastIndex = close + 1;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/**
 * `<img … src="url" alt="…">` as a link to its url, one without a url as its words alone; `<video>` as links to its
 * src and poster, or its word; `<source>` as a link to its src or srcset's first url, or nothing. With `links`, each
 * link an `<a>` that `anchorHref` keeps, else its words, as it is `inLink`.
 */
function htmlMediaLink(name: string, tag: string, links?: HtmlLinks, inLink = false): string {
  const attribute = (attributeName: string) => {
    const match = new RegExp(`\\s${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
    return match ? (match[1] ?? match[2] ?? match[3]).replace(/&amp;/g, "&") : "";
  };
  const link = (label: string, url: string) => {
    if (!links) return `[${label}](${destination(url)})`;
    const href = inLink ? null : anchorHref(url, links.tree);
    return href ? `<a href="${href}">${label.replace(/</g, "&lt;")}</a>` : label;
  };
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

/**
 * `![alt](url)` and `![alt][ref]` as `[Image: alt](url)` and `[Image: alt][ref]`; `![alt][]` and `![alt]`, whose label
 * is the alt, keep it as the reference, where it's a label (`isLabel`). Inside a link's text, or an image's alt, where a
 * link can't go, an image is its words. Any other `![`, as one whose definition sits in a quote or a list, has its `!`
 * escaped: at most a link, never an image. Each `![` is weighed once and each alt read once, so no nesting or run of
 * openers stalls the page.
 */
function linkMarkdownImages(text: string, labels: Set<string>): string {
  if (!text.includes("![")) return text;
  const { bracket, paren, holdsSquare } = pairing(text);

  /**
   * The image the `![` at `at` begins, its whole within `stop`: where its alt's `]` and the image end, and the label
   * it refers to (null for a destination); or null.
   */
  const imageAt = (at: number, stop: number): { end: number; after: number; ref: string | null } | null => {
    const end = bracket(at + 1);
    if (end < 0) return null;
    const next = end < stop ? text[end] : "";
    if (next === "(") {
      const after = paren(end);
      return after > 0 && after <= stop ? { end, after, ref: null } : null;
    }
    const alt = () => text.slice(at + 2, end - 1);
    if (next === "[") {
      const after = bracket(end);
      const ref = after > 0 ? text.slice(end + 1, after - 1) : "";
      const label = ref.trim() ? ref : alt();
      return after > 0 && after <= stop && isLabel(label) ? { end, after, ref: label } : null;
    }
    // A definition's label holds no `]`, so an alt with one is never its own reference.
    return !holdsSquare(at + 2, end - 1) && labels.has(normalLabel(alt())) && isLabel(alt()) ? { end, after: end, ref: alt() } : null;
  };

  /** The label of the image whose alt runs from `start` to `stop`, its brackets dropped and each image in it its words. */
  const labelOf = (start: number, stop: number): string => {
    // The alts being read, innermost last: each one's text before its first image, from there to the end of its last
    // image, and after that.
    const alts = [{ at: start, from: start, stop, before: "", images: "", after: "" }];
    const own = (alt: typeof alts[number], piece: string) => {
      if (alt.images) alt.after += piece.replace(/[[\]]/g, "");
      else alt.before += piece.replace(/[[\]]/g, "");
    };
    for (;;) {
      const alt = alts[alts.length - 1];
      let image: { end: number; after: number } | null = null;
      let at = alt.at;
      for (; at < alt.stop; at++) {
        if (text[at] === "\\") { at++; continue; }
        if (text[at] !== "!" || text[at + 1] !== "[") continue;
        if ((image = imageAt(at, alt.stop))) break;
        own(alt, `${text.slice(alt.from, at)}\\!`);
        alt.from = at + 1;
      }
      if (image) {
        own(alt, text.slice(alt.from, at));
        alt.at = alt.from = image.after;
        alts.push({ at: at + 2, from: at + 2, stop: image.end - 1, before: "", images: "", after: "" });
        continue;
      }
      own(alt, text.slice(alt.from, alt.stop));
      const label = alt.images ? `Image: ${alt.before.trimStart()}${alt.images}${alt.after.trimEnd()}` : imageLabel(alt.before);
      alts.pop();
      const outer = alts[alts.length - 1];
      if (!outer) return label;
      outer.images += outer.after + label;
      outer.after = "";
    }
  };

  const parts: string[] = [];
  let from = 0;
  // `[`s still open: an image after one is inside what may be a link's text.
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") { i++; continue; }
    if (char === "]" && open) { open--; continue; }
    if (char === "[") { open++; continue; }
    if (char !== "!" || text[i + 1] !== "[") continue;
    const image = imageAt(i, text.length);
    const before = text.slice(from, i) + (image ? "" : "\\!");
    if (before) parts.push(before);
    if (!image) { from = i + 1; continue; }
    const { end, after, ref } = image;
    const label = labelOf(i + 2, end - 1);
    pushLink(parts, open ? label : ref === null ? `[${label}]${text.slice(end, after)}` : `[${label}][${ref}]`);
    from = after;
    i = after - 1;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/**
 * Whether `text` is a link label as CommonMark reads one: no bracket that a `\\` doesn't escape, and at most 999
 * characters. Kept as a reference, anything else would be copied out unread, an image in it too.
 */
const isLabel = (text: string) => text.length <= 999 && /^(?:[^\\[\]]|\\[\s\S])*$/.test(text);

/**
 * Where `text`'s brackets and parentheses close, each worked out once: looking anew from each opener read to the end
 * for every one that never closed. `\` escapes the character after it.
 */
function pairing(text: string) {
  const length = text.length;
  // Each `[`'s close, the index just past its `]`, or -1; and each `(`'s inside a destination's parentheses, where
  // nothing else counts and a blank line ends it.
  const brackets = new Int32Array(length).fill(-1);
  const parens = new Int32Array(length).fill(-1);
  const squares: number[] = [];
  const rounds: number[] = [];
  for (let i = 0; i < length; i++) {
    const char = text[i];
    if (char === "\\") i++;
    else if (char === "[") squares.push(i);
    else if (char === "]") { if (squares.length) brackets[squares.pop()!] = i + 1; }
    else if (char === "(") rounds.push(i);
    else if (char === ")") { if (rounds.length) parens[rounds.pop()!] = i + 1; }
    else if (char === "\n" && text[i + 1] === "\n") rounds.length = 0;
  }
  // The first `>`, and the first `]`, at or after each index.
  const greater = new Int32Array(length + 1).fill(-1);
  const square = new Int32Array(length + 1).fill(length);
  for (let i = length - 1; i >= 0; i--) {
    greater[i] = text[i] === ">" ? i : greater[i + 1];
    square[i] = text[i] === "]" ? i : square[i + 1];
  }
  // `paren`'s answer from each index at the destination's own depth, outside a title (0), in a "…" one (1) or in a
  // '…' one (2); -2 until known. Every opener's search that reaches the same place goes on alike, so each is read once.
  const ends = new Int32Array(3 * length).fill(-2);

  /**
   * The index just past the `)` that closes the `(` at `open`, skipping a `<…>` destination and a quoted title; or -1
   * at a blank line or the end.
   */
  const paren = (open: number): number => {
    const seen: number[] = [];
    let title = 0;
    let end = -1;
    for (let i = open + 1; i < length;) {
      const key = 3 * i + title;
      if (ends[key] !== -2) { end = ends[key]; break; }
      seen.push(key);
      const char = text[i];
      if (char === "\\") i += 2;
      else if (title) { if (char === (title === 1 ? '"' : "'")) title = 0; i++; }
      else if (char === "<" && greater[i] >= 0) i = greater[i] + 1;
      else if ((char === '"' || char === "'") && /\s/.test(text[i - 1])) { title = char === '"' ? 1 : 2; i++; }
      else if (char === "(") { if (parens[i] < 0) break; i = parens[i]; }
      else if (char === ")") { end = i + 1; break; }
      else if (char === "\n" && text[i + 1] === "\n") break;
      else i++;
    }
    for (const key of seen) ends[key] = end;
    return end;
  };

  return { bracket: (open: number) => brackets[open], paren, holdsSquare: (from: number, to: number) => square[from] < to };
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
 * backtick. Where a rendered file's links are kept (`anchors`), an `<a>` too, with any attributes written so: its first
 * `href`, as an HTML parser takes the first, is read, for `linkTag` to keep alone.
 */
function formattingTag(text: string, at: number, anchors = false): { name: string; close: boolean; end: number; href?: string } | null {
  const head = /<(\/?)([A-Za-z][A-Za-z0-9]*)/y;
  head.lastIndex = at;
  const match = head.exec(text);
  if (!match) return null;
  const name = match[2].toLowerCase();
  const link = anchors && name === "a";
  const allowed = FORMATTING.get(name);
  if (!allowed && !link) return null;
  let end = head.lastIndex;
  let href: string | undefined;
  if (!match[1]) {
    const attribute = /[ \t]+([A-Za-z][A-Za-z0-9-]*)(?:[ \t]*=[ \t]*("[^"'<>`\n]*"|'[^"'<>`\n]*'|[^\s"'=<>`]+))?/y;
    for (let found; (attribute.lastIndex = end, found = attribute.exec(text));) {
      const attributeName = found[1].toLowerCase();
      if (!link && !allowed!.includes(attributeName)) return null;
      if (link && attributeName === "href" && href === undefined) href = (found[2] ?? "").replace(/^(["'])([\s\S]*)\1$/, "$2");
      end = attribute.lastIndex;
    }
  }
  const close = match[1] ? /[ \t]*>/y : /[ \t]*\/?>/y;
  close.lastIndex = end;
  return close.exec(text) ? { name, close: !!match[1], end: close.lastIndex, ...(href !== undefined ? { href } : {}) } : null;
}

/** A url or email autolink, or a link destination in angle brackets with a scheme: neither is ever an HTML tag. */
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\n`]*|[A-Za-z0-9.!#$%&'*+/=?^_{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;

/**
 * The end of what the `<` at `at` begins that's left as written: a FORMATTING tag, or on an inline line an autolink
 * (in an HTML block it would be a tag); or -1.
 */
function keptEnd(text: string, at: number, inline: boolean, anchors = false): number {
  const tag = formattingTag(text, at, anchors);
  if (tag) return tag.end;
  AUTOLINK.lastIndex = at;
  return inline && AUTOLINK.test(text) ? AUTOLINK.lastIndex : -1;
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;

/**
 * `text` with every `<` outside code that isn't kept (`keptEnd`) as `&lt;`, and any `![` left outside code as `\![`.
 * Each `<` is judged in `text` as given, so escaping one can't make a tag of what's around it. On inline text `\<`
 * is `&lt;` too: it shows the same, and is text still if BB reads the line as HTML. With `links`, each `<a>` and `</a>`
 * is kept as `linkTag` writes it, a tag where one was, so the text reads as it did.
 */
function escapeHtml(text: string, links?: HtmlLinks): string {
  const anchors = !!links;
  const { lines, spans } = structure(text, anchors);
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
        const kept = keptEnd(text, i, kind === "inline", anchors);
        // In a table's row, GFM splits cells at a `|` before it reads a tag: an <a> holding one would be a tag only as
        // written again without it, so it shows as text.
        const link = links && kept > 0 ? linkTag(text, i, links) : null;
        const split = link !== null && kind === "row" && text.slice(i, kept).includes("|");
        out += kept > 0 && !split ? link ?? keptText(text, i, kept, anchors) : "&lt;";
        i = kept > 0 && !split ? kept : i + 1;
      } else {
        out += char === "!" && text[i + 1] === "[" ? "\\!" : char;
        i++;
      }
    }
    if (end < text.length) out += "\n";
  }
  return out;
}

/**
 * The kept `<…>` from `start` to `end` in `text`, as written but where BB can't read it as an autolink, which holds no
 * space or control character: then its `![`s, which BB reads as images, show as text too.
 */
function keptText(text: string, start: number, end: number, anchors = false): string {
  const kept = text.slice(start, end);
  if (!/[\x00-\x20\x7f]/.test(kept) || formattingTag(text, start, anchors)) return kept;
  return kept.replace(/\\[!-/:-@[-`{-~]|!(?=\[)/g, (match) => match === "!" ? "\\!" : match);
}

/**
 * Where `markdown`'s code is, as linkImages reads it: the lines of its fenced code, and its code spans, in order. With
 * `anchors`, as it reads a rendered file's, whose `<a>` tags are kept.
 */
export function codeRanges(markdown: string, anchors = false): Array<readonly [number, number]> {
  const { lines, spans } = structure(markdown, anchors);
  return [...lines.filter((line) => line.kind === "fence").map(({ start, end }) => [start, end] as const), ...spans].sort((a, b) => a[0] - b[0]);
}

/** `text` with `change` made to each stretch between its code. */
function outsideCode(text: string, change: (prose: string) => string, anchors = false): string {
  let out = "";
  let from = 0;
  for (const [start, end] of codeRanges(text, anchors)) {
    out += change(text.slice(from, start)) + text.slice(start, end);
    from = end;
  }
  return out + change(text.slice(from));
}

type LineKind = "fence" | "inline" | "row" | "raw";
interface Line { start: number; end: number; kind: LineKind }

/**
 * Each line of `text` as CommonMark with GFM reads it once `escapeHtml` has run, so only FORMATTING tags can begin an
 * HTML block: a fenced code block's, inline text (a paragraph's or a heading's), a GFM table's row, or anything else;
 * and the code spans in inline text and rows. See `lineKinds` and `codeSpans`. With `anchors`, an `<a>` is a tag too.
 */
function structure(text: string, anchors = false): { lines: Line[]; spans: Array<[number, number]> } {
  const rows = text.split("\n");
  const kinds = lineKinds(rows, anchors);
  const lines: Line[] = [];
  let start = 0;
  rows.forEach((row, index) => {
    lines.push({ start, end: start + row.length, kind: kinds[index] });
    start += row.length + 1;
  });
  return { lines, spans: codeSpans(text, lines, anchors) };
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
 * Where a reading is in doubt, every row from there on is raw, so nothing after it is kept as code: a tab in a
 * quote's or list item's indent; front matter, a math block (`$$`), a directive (`:::`) or a GFM footnote definition
 * (`[^`), whose indented rows are its blocks; a lone tag after a paragraph's line; a fence or HTML block that a row
 * outside its quote or list item ends; a table, or a paragraph that may be a link definition, that a block interrupts
 * or a lazy row continues. Readers other than CommonMark's, or GFM's, may read those otherwise.
 */
function lineKinds(rows: string[], anchors = false): LineKind[] {
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
    const afterIndented = all && leaf?.kind === "indented";
    if (afterIndented) {
      const rest = row.slice(pos);
      if (blank(rest) || spaces(rest) >= 4 || (!stack.length && rest[spaces(rest)] === "\t")) return "raw";
      if (rest[spaces(rest)] === "\t") return null;
      leaf = null;
    }
    const paragraph = leaf?.kind === "paragraph" ? leaf : null;
    // CommonMark's "the line's container is a paragraph": a setext underline, or a table's delimiter row.
    let matchedParagraph = all && !!paragraph;
    // micromark's "interrupt", where a list item can't begin empty or from other than 1: after indented code too.
    let interrupting = matchedParagraph || afterIndented;
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
      matchedParagraph = interrupting = false;
    };
    for (;;) {
      const rest = row.slice(pos);
      if (blank(rest)) break;
      const indent = spaces(rest);
      // Outside any container a tab in the first 4 columns takes the indent to 4; in one, it may split a tab stop.
      const tab = indent < 4 && rest[indent] === "\t";
      if (tab && stack.length) return null;
      const tail = rest.slice(indent);
      // CommonMark's "the tip is a paragraph": this row can go on with it, lazily too.
      const continues = !!paragraph && !opened;
      if (indent >= 4 || tab) {
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
      const fence = /^(?:`{3,}(?![^\n]*`)|~{3,})/.exec(tail);
      if (fence) {
        if (!close()) return null;
        leaf = { kind: "fence", char: fence[0][0], length: fence[0].length };
        fill();
        return "fence";
      }
      const html = htmlBlock(tail, anchors);
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
        for (let n = paragraph!.first; n < index; n++) kinds[n] = "row";
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
        if (!(interrupting && (empty || (item[1] !== undefined && item[1] !== "1")))) {
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
      return paragraph.table ? "row" : "inline";
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
function htmlBlock(text: string, anchors = false): 0 | 1 | 6 | 7 {
  const tag = text[0] === "<" ? formattingTag(text, 0, anchors) : null;
  if (!tag) return 0;
  if (!tag.close && tag.name === "pre" && text[4] !== "/") return 1;
  if (BLOCK_TAGS.has(tag.name)) return 6;
  return blank(text.slice(tag.end)) ? 7 : 0;
}

/**
 * The code spans CommonMark finds in inline `lines` and table rows, read as `escapeHtml` leaves them. Backticks pair
 * within a line; within a run of lines between blank lines and fences, once a backtick may go uncounted (one no line
 * closes, or one a GFM autolink literal, math, a directive, a link's destination or title, a reference, a footnote's
 * label or a definition may hold), the run's later backticks are text. Math begins at `$$`: BB reads no single `$` as
 * math.
 */
function codeSpans(text: string, lines: Line[], anchors = false): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let paired = true;
  for (const { start, end, kind } of lines) {
    const line = text.slice(start, end);
    if (kind === "fence" || blank(line)) {
      paired = true;
      continue;
    }
    if (!paired) continue;
    const found = lineSpans(line, kind === "inline", anchors);
    paired = found.paired;
    // A table's row, which BB may read as a paragraph's line or as cells: only a span that's one both ways.
    const cells = kind === "row" && new Set(tableCells(line).flatMap(([from, to]) => lineSpans(line.slice(from, to), false, anchors).spans.map(([a, b]) => `${from + a} ${from + b}`)));
    for (const [a, b] of found.spans) if (kind === "inline" || (cells && cells.has(`${a} ${b}`))) spans.push([start + a, start + b]);
  }
  return spans;
}

/** The code spans in `line` (see `codeSpans`) up to a backtick that may go uncounted, and whether there was none. */
function lineSpans(line: string, inline: boolean, anchors = false): { spans: Array<[number, number]>; paired: boolean } {
  const spans: Array<[number, number]> = [];
  // Where the word at `i` begins: an autolink literal runs to a space.
  let word = 0;
  let ticks: Uint8Array | null = null;
  for (let i = 0; i < line.length;) {
    const char = line[i];
    const next = line[i + 1] ?? "";
    if (char === "\\" && PUNCTUATION.test(next)) i += 2;
    else if (char === " " || char === "\t") word = ++i;
    else if (char === "<") {
      const kept = keptEnd(line, i, inline, anchors);
      i = kept > 0 ? (word = kept) : i + 1;
    } else if (char === "`") {
      const length = /^`+/.exec(line.slice(i))![0].length;
      const close = closingRun(line, i + length, length);
      if (close < 0 || /[:@]|www\./i.test(line.slice(word, i))) return { spans, paired: false };
      spans.push([i, close + length]);
      i = word = close + length;
    } else if ((char === "$" && next === "$") || (char === ":" && /[A-Za-z]/.test(next))) return { spans, paired: false };
    else if (char === "[" && next === "^" && (ticks ??= labelTicks(line))[i + 2]) return { spans, paired: false };
    else if (char === "]" && (next === ":" || (next === "(" && !simpleResource(line, i + 1)) || (next === "[" && !/^\[[^[\]\\`\n]*\]/.test(line.slice(i + 1))))) return { spans, paired: false };
    else i++;
  }
  return { spans, paired: true };
}

/**
 * For each index of `line`, 1 where a footnote label's characters from there reach a backtick: escapes, and anything
 * but a space or `]`. Worked out once for the line, from its end: testing the rest of the line at each `[^` was
 * quadratic.
 */
function labelTicks(line: string): Uint8Array {
  const ticks = new Uint8Array(line.length + 2);
  for (let i = line.length - 1; i >= 0; i--) {
    const char = line[i];
    if (char === "`") ticks[i] = 1;
    else if (char === "\\") ticks[i] = i + 1 < line.length && !/[\n\r\u2028\u2029]/.test(line[i + 1]) ? ticks[i + 2] : 0;
    else ticks[i] = /[\s\]]/.test(char) ? 0 : ticks[i + 1];
  }
  return ticks;
}

/** A table row's cells, as GFM splits it before it reads their code: at each pipe but `\|`, with `\\` an escape too. */
function tableCells(line: string): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  let from = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && (line[i + 1] === "\\" || line[i + 1] === "|")) i++;
    else if (line[i] === "|") {
      cells.push([from, i]);
      from = i + 1;
    }
  }
  return [...cells, [from, line.length]];
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
