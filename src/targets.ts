import { createHash } from "node:crypto";
import { parsePrLink } from "../lib/pr-link";

export type ReviewTarget =
  | { kind: "pr"; number: number; repo?: string }
  | { kind: "ref"; gitRef: string; base?: string };

export function parseTarget(input: string, base?: string): ReviewTarget {
  const trimmed = input.trim();
  // A PR's link, or owner/repo#n.
  const link = parsePrLink(trimmed);
  if (link) return { kind: "pr", number: link.number, repo: link.repo };
  if (/^[1-9]\d*$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))) return { kind: "pr", number: Number(trimmed) };
  return base ? { kind: "ref", gitRef: trimmed, base } : { kind: "ref", gitRef: trimmed };
}

export function targetKey(t: ReviewTarget, scope?: { projectId: string; cwd: string }): string {
  if (t.kind === "pr") return t.repo
    ? `pr-${createHash("sha256").update(t.repo.toLowerCase()).digest("hex").slice(0, 16)}-${t.number}`
    : `pr-${t.number}`;
  const hash = createHash("sha1")
    .update(JSON.stringify([scope?.projectId, scope?.cwd, t.gitRef, t.base ?? ""]))
    .digest("hex")
    .slice(0, 12);
  return `ref-${hash}`;
}
