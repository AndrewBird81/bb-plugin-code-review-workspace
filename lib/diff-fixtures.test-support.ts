// For tests, not the plugin: patches shaped like the diffs the diff view's layout is for.

/** A one-hunk patch from its blocks: unchanged lines, or lines deleted and added. */
export function hunkPatch(path: string, blocks: Array<{ same: number } | { del: number; add: number }>, start = 1): string {
  const rows: string[] = [];
  let old = 0, now = 0;
  for (const block of blocks) {
    if ("same" in block) {
      for (let i = 0; i < block.same; i++) rows.push(` same ${old + i + start}`);
      old += block.same;
      now += block.same;
      continue;
    }
    for (let i = 0; i < block.del; i++) rows.push(`-gone ${old + i + start}`);
    for (let i = 0; i < block.add; i++) rows.push(`+came ${now + i + start}`);
    old += block.del;
    now += block.add;
  }
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${start},${old} +${start},${now} @@\n${rows.join("\n")}\n`;
}

/**
 * The shape of a Terraform file handing its resources to another stack: a few lines replaced by a note and `removed`
 * blocks, then one resource deleted whole (177 lines), then another (62 lines, two of them replaced).
 */
export const MOVED_OUT = [{ del: 2, add: 5 }, { same: 1 }, { del: 9, add: 2 }, { same: 1 }, { del: 177, add: 0 }, { same: 2 }, { del: 62, add: 2 }, { same: 1 }, { del: 0, add: 3 }, { same: 3 }];
