import type { AgentMessageContext } from "./store";
import { patchRows, splitPatchByFile } from "./patch";
import { codeFence } from "./untrusted";

const MAX_QUOTE = 40_000;

/** A short label for a reviewer's file or selection, such as `api.ts:10–12`. */
export function contextLabel(context: AgentMessageContext): string {
  if (!context.file) return "whole change";
  const name = context.file.split("/").pop() ?? context.file;
  if (context.startLine == null) return name;
  return `${name}:${context.startLine}${context.endLine != null && context.endLine !== context.startLine ? `–${context.endLine}` : ""}`;
}

/**
 * Extract exactly the lines a reviewer selected (by 1-based line number on the
 * new or old side) from a file's unified diff, keeping the +/-/space prefixes.
 * Walks each hunk tracking old/new line counters. Returns "" if nothing matches.
 */
export function extractSelectedLines(
  patch: string,
  file: string,
  start: number,
  end: number,
  side: "additions" | "deletions" = "additions",
): string {
  const f = splitPatchByFile(patch).find((x) => x.path === file);
  if (!f) return "";
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const wantOld = side === "deletions";
  const out: string[] = [];
  for (const row of patchRows(f.text)) {
    if (!("oldLine" in row) || row.kind === (wantOld ? "+" : "-")) continue;
    const n = wantOld ? row.oldLine : row.newLine;
    if (n >= lo && n <= hi) out.push(row.text);
  }
  return out.join("\n");
}

/**
 * The reviewer's file or selection as a quote in their own message. A file
 * alone is named, not inlined; the assistant reads it with read_review_patch.
 */
export function contextQuote(context: AgentMessageContext, patch: string): string {
  if (!context.file) return "";
  const range = context.startLine == null ? ""
    : context.endLine != null && context.endLine !== context.startLine ? ` lines ${context.startLine}-${context.endLine}` : ` line ${context.startLine}`;
  if (context.code?.trim()) return `In \`${context.file}\`${range}:\n${codeFence(context.code, "")}`;
  if (context.startLine != null) {
    const lines = extractSelectedLines(patch, context.file, context.startLine, context.endLine ?? context.startLine, context.side).slice(0, MAX_QUOTE);
    if (lines.trim()) return `In \`${context.file}\`${range}:\n${codeFence(lines, "diff")}`;
  }
  return `About \`${context.file}\`${range}.`;
}
