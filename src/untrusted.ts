/**
 * Fence text people wrote on GitHub or in the PR, so an agent reads it as data.
 * Closing tags inside it are broken, so it can't end the fence early.
 */
export function untrusted(source: string, text: string): string {
  return `<untrusted source="${source}">\n${text.replace(/<\/(untrusted)/gi, "<\\/$1")}\n</untrusted>`;
}

/**
 * `text` as inline code, its backticks longer than any run in it, so nothing in it, such as a file's path, ends it. A line
 * break in it, which git allows in a path, is written `\n` or `\r`, so it stays on its line.
 */
export function inlineCode(raw: string): string {
  const text = raw.replace(/\r\n?|\n/g, (end) => end.replace("\r", "\\r").replace("\n", "\\n"));
  const ticks = "`".repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length + 1)));
  const pad = /^`|`$/.test(text) ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** `text` in a code fence of language `lang`, longer than any run of backticks in it, so nothing in it ends the fence. */
export function codeFence(text: string, lang = "text"): string {
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length + 1)));
  return `${fence}${lang}\n${text}\n${fence}`;
}
