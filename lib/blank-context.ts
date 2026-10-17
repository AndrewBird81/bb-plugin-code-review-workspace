// git's diff.suppressBlankEmpty writes a blank context line as "", not " ". src/patch.ts counts it, as the server reads
// lines for comments, but @pierre/diffs skips it, which would draw every line after it in the hunk one number short.
import { patchRows } from "../src/patch";

/** The diff with each blank context line written as "" inside a hunk's counts written as " ", as git writes it by default. */
export function withBlankContext(patch: string): string {
  if (!patch.includes("\n\n")) return patch;
  const lines = patch.split("\n");
  // One row per line.
  const rows = patchRows(patch);
  if (!rows.some((row, index) => row.kind === " " && lines[index] === "")) return patch;
  return lines.map((line, index) => rows[index].kind === " " && line === "" ? " " : line).join("\n");
}
