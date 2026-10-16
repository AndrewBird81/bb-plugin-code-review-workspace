import { splitPatchByFile } from "./patch";
import { hashFileDiff, normalizedFileHash } from "./diff-hash";
import type { FileView } from "./store";

export interface FileViewState {
  file: string;
  /** Marked viewed AND the file's diff is unchanged since. */
  viewed: boolean;
  /** Was marked viewed but the diff changed since (re-review moved it). */
  stale: boolean;
  /** When it was marked viewed. */
  viewedAt: number;
}

/** A patch's file hashes, each taken once, when first asked for. */
export interface FileHashes {
  /** Each file's rebase-proof hash (normalizedFileHash), which a mark stores; files not in the patch are left out. */
  current(files: readonly string[]): Map<string, string>;
  /** Each file's whole-diff hash (hashFileDiff), which marks saved before the rebase-proof hash stored. */
  legacy(files: readonly string[]): Map<string, string>;
}

/** Hashes of `patch`'s files, read when a file not hashed yet is asked for: the store keeps one per patch. */
export function fileHashCache(patch: () => string): FileHashes {
  const lookup = (hash: (text: string) => string) => {
    const taken = new Map<string, string | null>();
    return (files: readonly string[]) => {
      const missing = new Set(files.filter((file) => !taken.has(file)));
      if (missing.size) {
        for (const f of splitPatchByFile(patch())) if (missing.has(f.path)) taken.set(f.path, hash(f.text));
        for (const file of missing) if (!taken.has(file)) taken.set(file, null);
      }
      return new Map(files.flatMap((file) => { const h = taken.get(file); return h == null ? [] : [[file, h] as const]; }));
    };
  };
  return { current: lookup(normalizedFileHash), legacy: lookup(hashFileDiff) };
}

/** Hash of a single file's current diff, or null if it's not in the patch. */
export function hashForFile(patch: string, file: string): string | null {
  return fileHashCache(() => patch).current([file]).get(file) ?? null;
}

/** Resolve stored view rows against the current patch's hashes into viewed/stale flags, hashing only their files. */
export function computeFileViewState(stored: FileView[], hashes: FileHashes): FileViewState[] {
  const current = hashes.current(stored.map((v) => v.file));
  // Marks saved before the rebase-proof hash stored the whole-diff hash; accept either.
  const legacy = hashes.legacy(stored.filter((v) => current.has(v.file) && current.get(v.file) !== v.hash).map((v) => v.file));
  return stored.map((v) => {
    const cur = current.get(v.file);
    const matches = cur != null && (cur === v.hash || legacy.get(v.file) === v.hash);
    return { file: v.file, viewed: matches, stale: cur != null && !matches, viewedAt: v.viewedAt };
  });
}
