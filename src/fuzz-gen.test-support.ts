// Seeded generators for the bug bash's property tests.
export function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  return { next, int, pick, bool: (p = 0.5) => next() < p };
}
export type Rng = ReturnType<typeof rng>;

/** Line contents that look like diff syntax. */
export const NASTY = ["", "-- x", "++ y", "--- a/x", "+++ b/x", "-", "+", "@@ -1 +1 @@", "@@ -1,2 +3,4 @@ f()", "diff --git a/q b/q", "\\ No newline at end of file", "  indented", "\t", "x", "index 1..2 100644", "rename from z", "--", "++", " ", "Binary files a/x and b/x differ", "new file mode 100644"];

export interface Op { kind: "+" | "-" | " "; text: string; oldLine: number; newLine: number }
export interface GenHunk { header: string; ops: Op[]; blankAsEmpty: boolean[] }

/** A file's hunks, with every line's numbers, as git writes them. */
export function genHunks(r: Rng, opts: { maxHunks?: number; content?: () => string } = {}): { hunks: GenHunk[]; text: string } {
  const content = opts.content ?? (() => (r.bool(0.6) ? r.pick(NASTY) : `w${r.int(0, 9)}`));
  let oldPos = r.int(1, 5), newPos = oldPos + r.int(-2, 2);
  if (newPos < 1) newPos = 1;
  const hunks: GenHunk[] = [];
  const n = r.int(1, opts.maxHunks ?? 4);
  for (let h = 0; h < n; h++) {
    if (h) { const gap = r.int(1, 6); oldPos += gap; newPos += gap; }
    const ops: Op[] = [];
    const len = r.int(1, 8);
    for (let i = 0; i < len; i++) {
      const kind = r.pick(["+", "-", " "] as const);
      ops.push({ kind, text: content(), oldLine: oldPos, newLine: newPos });
      if (kind !== "+") oldPos++;
      if (kind !== "-") newPos++;
    }
    const oc = ops.filter((o) => o.kind !== "+").length, nc = ops.filter((o) => o.kind !== "-").length;
    const os = oc ? ops.find((o) => o.kind !== "+")!.oldLine : ops[0].oldLine - 1;
    const ns = nc ? ops.find((o) => o.kind !== "-")!.newLine : ops[0].newLine - 1;
    const count = (start: number, c: number) => (c === 1 ? `${start}` : `${start},${c}`);
    const header = `@@ -${count(os, oc)} +${count(ns, nc)} @@${r.bool(0.3) ? " function f() {" : ""}`;
    hunks.push({ header, ops, blankAsEmpty: ops.map((o) => o.kind === " " && o.text === "" && r.bool(0.5)) });
  }
  const text = hunks.map((hk) => [hk.header, ...hk.ops.map((o, i) => (hk.blankAsEmpty[i] ? "" : o.kind + o.text))].join("\n")).join("\n");
  return { hunks, text };
}
