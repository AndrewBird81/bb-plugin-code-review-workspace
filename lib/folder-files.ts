// What a local review keeps out of its diff, and why, in words the page and the server share (src/env-diff.ts).
import type { SnapshotFiles } from "../src/store";

/** A file kept out of the patch, and why: it looks like a secret, it's binary, or its diff is too large. */
export type HiddenFile = SnapshotFiles["hidden"][number];

/** Untracked files with these names stay out until included: `.env*`, `*.pem`, `*.key`, `credentials*`. */
export function isSecretPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return name.startsWith(".env") || name.endsWith(".pem") || name.endsWith(".key") || name.startsWith("credentials");
}

/** What the review says about a file it doesn't show. */
export function hiddenFileNotice(file: HiddenFile): string {
  switch (file.reason) {
    case "secret": return `${file.path} looks like a secret, so it isn’t shown or sent to agents. Include it to review it.`;
    case "binary": return `${file.path} is a binary file, so its contents aren’t shown or sent to agents.`;
    case "large": return `${file.path}’s diff is too large to show. Review it in the folder.`;
  }
}

/** What the review says about a committed file that looks like a secret. */
export const flaggedFileNotice = (path: string) => `${path} looks like a secret and is committed. Check it belongs in the repo.`;

/**
 * Where a file's diff says it links to, when it's a symbolic link (mode 120000) on its new side; null otherwise. A file
 * that changed type, as a regular file replaced by a link, has two blocks, the old file's deletion then the link.
 */
export function symlinkTarget(fileDiff: string): string | null {
  for (const block of fileDiff.split(/^(?=diff --git )/m)) {
    if (!/^(?:new file mode|new mode) 120000$|^index \S+ 120000$/m.test(block)) continue;
    const line = block.split("\n").find((row) => row.startsWith("+") && !row.startsWith("+++"));
    return line ? line.slice(1) : null;
  }
  return null;
}
