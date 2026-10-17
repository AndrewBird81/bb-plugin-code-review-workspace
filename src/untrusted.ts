/**
 * Fence text people wrote on GitHub or in the PR, so an agent reads it as data.
 * Closing tags inside it are broken, so it can't end the fence early.
 */
export function untrusted(source: string, text: string): string {
  return `<untrusted source="${source}">\n${text.replace(/<\/(untrusted)/gi, "<\\/$1")}\n</untrusted>`;
}

/** `text` in a code fence of language `lang`, longer than any run of backticks in it, so nothing in it ends the fence. */
export function codeFence(text: string, lang = "text"): string {
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length + 1)));
  return `${fence}${lang}\n${text}\n${fence}`;
}
