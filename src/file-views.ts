import { splitPatchByFile } from "./patch";
import { hashFileDiff, normalizedFileHash } from "./diff-hash";
import type { FileView } from "./store";

export interface FileViewState {
  file: string;
  /** Marked viewed AND the file's diff is unchanged since. */
  viewed: boolean;
  /** Was marked viewed but the diff changed since (re-review moved it). */
  stale: boolean;
}

/** Current content hash of each of these files, keyed by path; files not in the patch are left out. */
export function fileHashes(patch: string, files: string[]): Map<string, string> {
  const wanted = new Set(files);
  const m = new Map<string, string>();
  for (const f of splitPatchByFile(patch)) if (wanted.has(f.path)) m.set(f.path, normalizedFileHash(f.text));
  return m;
}

/** Hash of a single file's current diff, or null if it's not in the patch. */
export function hashForFile(patch: string, file: string): string | null {
  return fileHashes(patch, [file]).get(file) ?? null;
}

/** Resolve stored view rows against the current patch into viewed/stale flags. */
export function computeFileViewState(stored: FileView[], patch: string): FileViewState[] {
  // Marks saved before the rebase-proof hash stored the whole-diff hash; accept either.
  const current = new Map<string, string[]>();
  for (const f of splitPatchByFile(patch)) {
    if (f.path) current.set(f.path, [normalizedFileHash(f.text), hashFileDiff(f.text)]);
  }
  return stored.map((v) => {
    const cur = current.get(v.file);
    const matches = cur != null && cur.includes(v.hash);
    return { file: v.file, viewed: matches, stale: cur != null && !matches };
  });
}
