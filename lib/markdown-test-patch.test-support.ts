import { structuredPatch } from "diff";

/** A file's diff from `old` to `now` as git writes it, with `context` lines around each change; null for a file added or deleted whole. */
export function gitPatch(path: string, old: string | null, now: string | null, context = 3): string {
  const { hunks } = structuredPatch(`a/${path}`, `b/${path}`, old ?? "", now ?? "", "", "", { context });
  const start = (from: number, count: number) => `${count ? from : from - 1},${count}`;
  return [
    `diff --git a/${path} b/${path}`,
    ...(old === null ? ["new file mode 100644", "--- /dev/null"] : [`--- a/${path}`]),
    ...(now === null ? ["deleted file mode 100644", "+++ /dev/null"] : [`+++ b/${path}`]),
    ...hunks.flatMap((h) => [`@@ -${start(h.oldStart, h.oldLines)} +${start(h.newStart, h.newLines)} @@`, ...h.lines]),
    "",
  ].join("\n");
}
