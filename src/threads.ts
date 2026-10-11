export interface CheckItem { name: string; bucket: string; state: string; link?: string }
export interface ChecksSummary { bucket: "pass" | "fail" | "pending" | "none"; checks: CheckItem[] }

export function parseChecks(raw: string): ChecksSummary {
  let items: any[] = [];
  try { items = JSON.parse(raw); } catch { return { bucket: "none", checks: [] }; }
  if (!Array.isArray(items) || items.length === 0) return { bucket: "none", checks: [] };
  const checks: CheckItem[] = items.map((c) => ({ name: c.name, bucket: c.bucket, state: c.state, link: c.link }));
  const buckets = new Set(checks.map((c) => c.bucket));
  const bucket = buckets.has("fail") ? "fail"
    : buckets.has("pending") ? "pending"
    : buckets.has("pass") ? "pass"
    : "none";
  return { bucket, checks };
}

export interface ThreadComment { id: string; databaseId: number; author: string; body: string }
export interface ReviewThread {
  id: string; isResolved: boolean; isOutdated: boolean; path: string | null; line: number | null;
  /** Which side of the diff its line is on: the old file's (LEFT) or the new file's. */
  side: "LEFT" | "RIGHT";
  comments: ThreadComment[];
}
export function parseReviewThreads(raw: string): { threads: ReviewThread[] } {
  let root: any;
  try { root = JSON.parse(raw); } catch { return { threads: [] }; }
  const nodes = root?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const threads: ReviewThread[] = nodes.map((t: any) => ({
    id: t.id, isResolved: !!t.isResolved, isOutdated: !!t.isOutdated, path: t.path ?? null, line: t.line ?? null,
    side: t.diffSide === "LEFT" ? "LEFT" : "RIGHT",
    comments: (t.comments?.nodes ?? []).map((c: any) => ({
      id: c.id, databaseId: c.databaseId, author: c.author?.login ?? "unknown", body: c.body ?? "",
    })),
  }));
  return { threads };
}
