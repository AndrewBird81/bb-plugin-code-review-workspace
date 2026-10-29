import type { Severity } from "../src/draft";

export type DraftRecovery = {
  /**
   * Unsaved text in the comment box: a line comment's, or with `summary` the review summary's.
   * `inline` when it was being written in the diff rather than the panel;
   * `asking` when it was a message to the agent; `startLine`, and `startSide` when it differs, when it was about several lines;
   * `severity`, the comment's, when it has one; `editing`, when the box edits the line's comment, that comment's text as
   * the box opened on it, else the box is a new comment's; `filled`, what the plugin put in it, unknown when absent.
   */
  composer?: { file: string; line: string; side: "LEFT" | "RIGHT"; body: string; revision?: string; inline?: boolean; asking?: boolean; startLine?: number; startSide?: "LEFT" | "RIGHT"; summary?: boolean; severity?: Severity; editing?: string; filled?: string[] };
  /** Unsaved summary text from before the summary had a box of its own, kept while the box holds something else. */
  summary?: { body: string; revision?: string };
};
const key = (targetKey: string) => `code-review-workspace:draft-recovery:${targetKey}`;
const flag = (value: unknown) => [undefined, true, false].includes(value as boolean | undefined);

/** Per-tab storage avoids mixing unsaved text from two review windows. */
export function readDraftRecovery(targetKey: string): DraftRecovery {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(targetKey)) ?? "{}");
    const result: DraftRecovery = {};
    const revisionValid = (item: any) => item.revision === undefined || typeof item.revision === "string";
    if (value.composer && revisionValid(value.composer) && ["file", "line", "body"].every(k => typeof value.composer[k] === "string") && ["LEFT", "RIGHT"].includes(value.composer.side) && flag(value.composer.inline) && flag(value.composer.asking) && flag(value.composer.summary) && (value.composer.startLine === undefined || Number.isInteger(value.composer.startLine)) && [undefined, "LEFT", "RIGHT"].includes(value.composer.startSide) && (value.composer.editing === undefined || typeof value.composer.editing === "string")) {
      // A box from before range comments kept a selection's other end, which may come after its line.
      const { startLine, ...composer } = value.composer;
      result.composer = !value.composer.startSide && startLine > Number(value.composer.line) ? composer : value.composer;
      // What the plugin put in it, unless that can't be read: then it's unknown.
      const { filled } = value.composer;
      if (!(Array.isArray(filled) && filled.every((text) => typeof text === "string"))) delete result.composer!.filled;
    }
    if (value.summary && revisionValid(value.summary) && typeof value.summary.body === "string" && value.summary.body.trim()) {
      const summary = { body: value.summary.body, ...(value.summary.revision ? { revision: value.summary.revision } : {}) };
      // The summary's own box takes it, unless the box holds something else.
      if (result.composer) result.summary = summary;
      else result.composer = { file: "", line: "0", side: "RIGHT", ...summary, summary: true };
    }
    return result;
  } catch { return {}; }
}

export function updateDraftRecovery(targetKey: string, update: Partial<DraftRecovery>) {
  try {
    const next = { ...readDraftRecovery(targetKey), ...update };
    if (!next.composer && !next.summary) sessionStorage.removeItem(key(targetKey));
    else sessionStorage.setItem(key(targetKey), JSON.stringify(next));
  } catch { /* Keep in-memory text and beforeunload protection if storage is full. */ }
}
