// GitHub shows the images in its comments through its own proxy. BB's Markdown would load them from wherever they point,
// telling that server who read the text and when, so the text of others and of agents shows each image as a link to it.

/**
 * `markdown` with each image as a link to it, `[Image: alt](url)` or `[Image](url)`, so nothing loads until it's
 * clicked: inline and reference images, and HTML `<img>`. An image inside a link's text becomes its words, the link
 * kept. Code is changed too: whether backticks make a code span, or a fence code, depends on links, HTML blocks, tables
 * and list items around them, so an image written inside code shows as a link.
 */
export function linkImages(markdown: string): string {
  if (!/!\[|<img\b/i.test(markdown)) return markdown;
  const text = markdown.replace(/\r\n?/g, "\n");
  const labels = new Set([...text.matchAll(/^ {0,3}\[([^\]\n]+)\]:/gm)].map((match) => normalLabel(match[1])));
  return linkMarkdownImages(linkHtmlImages(text), labels);
}

const normalLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();
const imageLabel = (alt: string) => alt.trim() ? `Image: ${alt.trim()}` : "Image";

/** `text` and then `link`: a `!` ending the text is escaped, so that with a link's `[` it isn't an image. */
const thenLink = (text: string, link: string) => link.startsWith("[") && /(^|[^\\])(\\\\)*!$/.test(text) ? `${text.slice(0, -1)}\\!${link}` : text + link;

/** Each `<img>` in `text` as its link. */
function linkHtmlImages(text: string): string {
  let out = "";
  let from = 0;
  for (const { 0: tag, index } of text.matchAll(/<img\b[^>]*>/gi)) {
    out = thenLink(out + text.slice(from, index), htmlImageLink(tag));
    from = index + tag.length;
  }
  return out + text.slice(from);
}

/** `<img … src="url" alt="…">` as a link to its url; one without a url as its words alone. */
function htmlImageLink(tag: string): string {
  const attribute = (name: string) => {
    const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
    return match ? (match[1] ?? match[2] ?? match[3]).replace(/&amp;/g, "&") : "";
  };
  const url = attribute("src") || attribute("srcset").trim().split(/\s+/)[0] || "";
  const label = imageLabel(attribute("alt").replace(/[[\]]/g, ""));
  return url ? `[${label}](${destination(url)})` : label;
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
