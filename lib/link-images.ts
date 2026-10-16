// GitHub shows the images in its comments through its own proxy. BB's Markdown would load them from wherever they point,
// telling that server who read the text and when, so the text of others and of agents shows each image as a link to it.

/**
 * `markdown` with each image as a link to it, `[Image: alt](url)` or `[Image](url)`, so nothing loads until it's
 * clicked: inline and reference images, and HTML `<img>`. An image inside a link's text becomes its words, the link
 * kept. Code spans and fences are left as written.
 */
export function linkImages(markdown: string): string {
  if (!/!\[|<img\b/i.test(markdown)) return markdown;
  const labels = new Set([...markdown.matchAll(/^ {0,3}\[([^\]\n]+)\]:/gm)].map((match) => normalLabel(match[1])));
  return outsideFences(markdown, (text) => outsideCodeSpans(text, (prose) => linkMarkdownImages(linkHtmlImages(prose), labels)));
}

const normalLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();
const imageLabel = (alt: string) => alt.trim() ? `Image: ${alt.trim()}` : "Image";

/** Runs `change` over the text between fenced code blocks, which stay as they are. */
function outsideFences(markdown: string, change: (text: string) => string): string {
  const lines = markdown.split("\n");
  const parts: string[] = [];
  let prose: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    // A backtick fence's info string has no backtick.
    if (!open || (open[1][0] === "`" && lines[i].slice(open[0].length).includes("`"))) { prose.push(lines[i]); continue; }
    if (prose.length) parts.push(change(prose.join("\n")));
    prose = [];
    const fence = new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !fence.test(lines[end])) end++;
    parts.push(lines.slice(i, end + 1).join("\n"));
    i = end;
  }
  if (prose.length) parts.push(change(prose.join("\n")));
  return parts.join("\n");
}

/** Runs `change` over the text between code spans, which stay as they are. */
function outsideCodeSpans(text: string, change: (prose: string) => string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length;) {
    if (text[i] !== "`" || (i > 0 && text[i - 1] === "\\")) { i++; continue; }
    let run = i;
    while (text[run] === "`") run++;
    const ticks = text.slice(i, run);
    let close = run;
    for (;;) {
      close = text.indexOf(ticks, close);
      if (close < 0 || text[close + ticks.length] !== "`") break;
      while (text[close] === "`") close++;
    }
    if (close < 0) { i = run; continue; }
    out += change(text.slice(from, i)) + text.slice(i, close + ticks.length);
    i = from = close + ticks.length;
  }
  return out + change(text.slice(from));
}

/** `<img … src="url" alt="…">` as a link to its url; one without a url as its words alone. */
function linkHtmlImages(text: string): string {
  return text.replace(/<img\b[^>]*>/gi, (tag) => {
    const attribute = (name: string) => {
      const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
      return match ? (match[1] ?? match[2] ?? match[3]).replace(/&amp;/g, "&") : "";
    };
    const url = attribute("src") || attribute("srcset").trim().split(/\s+/)[0] || "";
    const label = imageLabel(attribute("alt").replace(/[[\]]/g, ""));
    return url ? `[${label}](${destination(url)})` : label;
  });
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
 * is the alt, keep it as the reference. Inside a link's text, where a link can't go, an image is its words.
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
    if (end < 0) continue;
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
    if (replaced === null) continue;
    out += text.slice(from, i) + replaced;
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
