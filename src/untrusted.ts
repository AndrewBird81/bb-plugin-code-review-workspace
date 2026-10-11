/**
 * Fence text people wrote on GitHub or in the PR, so an agent reads it as data.
 * Closing tags inside it are broken, so it can't end the fence early.
 */
export function untrusted(source: string, text: string): string {
  return `<untrusted source="${source}">\n${text.replace(/<\/(untrusted)/gi, "<\\/$1")}\n</untrusted>`;
}
