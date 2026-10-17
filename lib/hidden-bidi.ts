// Trojan Source (CVE-2021-42574): bidirectional controls make code draw in an order other than the one it runs in.
import { patchRows } from "../src/patch";

/** The controls GitHub warns of: the embeddings and overrides, U+202A–U+202E, and the isolates, U+2066–U+2069. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/;

/** Whether a file's path or the lines its diff adds hold a bidirectional control. */
export function hasHiddenBidi(path: string, patch: string): boolean {
  return BIDI_CONTROLS.test(path) || patchRows(patch).some((row) => row.kind === "+" && BIDI_CONTROLS.test(row.text));
}
