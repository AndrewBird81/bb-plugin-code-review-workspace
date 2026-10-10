export type DraftRecovery = {
  /**
   * Unsaved text in the comment box: a line comment's, or the review summary's at src/draft.ts SUMMARY_AT.
   * `inline` when it was being written in the diff rather than the panel;
   * `asking` when it was a message to the agent, about lines from `startLine`.
   */
  composer?: { file: string; line: string; side: "LEFT" | "RIGHT"; body: string; revision?: string; inline?: boolean; asking?: boolean; startLine?: number };
};
const key = (targetKey: string) => `guided-review:draft-recovery:${targetKey}`;

/** Per-tab storage avoids mixing unsaved text from two review windows. */
export function readDraftRecovery(targetKey: string): DraftRecovery {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(targetKey)) ?? "{}");
    const result: DraftRecovery = {};
    const revisionValid = (item: any) => item.revision === undefined || typeof item.revision === "string";
    if (value.composer && revisionValid(value.composer) && ["file", "line", "body"].every(k => typeof value.composer[k] === "string") && ["LEFT", "RIGHT"].includes(value.composer.side) && [undefined, true, false].includes(value.composer.inline) && [undefined, true, false].includes(value.composer.asking) && (value.composer.startLine === undefined || Number.isInteger(value.composer.startLine))) result.composer = value.composer;
    // Before the summary had a comment box of its own, its unsaved text was kept apart.
    else if (value.summary && revisionValid(value.summary) && typeof value.summary.body === "string" && value.summary.body.trim()) result.composer = { file: "", line: "0", side: "RIGHT", body: value.summary.body, revision: value.summary.revision };
    return result;
  } catch { return {}; }
}

export function updateDraftRecovery(targetKey: string, update: Partial<DraftRecovery>) {
  try {
    const next = { ...readDraftRecovery(targetKey), ...update };
    if (!next.composer) sessionStorage.removeItem(key(targetKey));
    else sessionStorage.setItem(key(targetKey), JSON.stringify(next));
  } catch { /* Keep in-memory text and beforeunload protection if storage is full. */ }
}
