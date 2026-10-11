// CI failures on the lines they're about: check-run annotations at the reviewed head. Read-only.
import type { ReviewMeta } from "./store";
import type { runGh } from "./gh";

export interface CheckFailure { file: string; line: number; check: string; title: string | null; message: string; url: string }

/** A head's failed check runs are few; past this many, the rest don't add lines worth showing. */
const MAX_RUNS = 10;

function parse<T>(text: string): T | null {
  try { return JSON.parse(text) as T; } catch { return null; }
}

/** The failure annotations of a PR's failed check runs at its reviewed head; none when GitHub can't say. */
export async function readCheckFailures(gh: typeof runGh, review: ReviewMeta): Promise<CheckFailure[]> {
  if (review.kind !== "pr" || !review.repo || !review.headSha) return [];
  const listed = await gh(["api", `repos/${review.repo}/commits/${review.headSha}/check-runs?per_page=100`]);
  type Run = { id: number; name: string; conclusion: string | null; html_url: string; output?: { annotations_count?: number } };
  const runs = (listed.code === 0 ? parse<{ check_runs?: Run[] }>(listed.stdout)?.check_runs ?? [] : [])
    .filter((run) => run.conclusion === "failure" && (run.output?.annotations_count ?? 0) > 0)
    .slice(0, MAX_RUNS);
  const perRun = await Promise.all(runs.map(async (run) => {
    const out = await gh(["api", `repos/${review.repo}/check-runs/${run.id}/annotations?per_page=50`]);
    type Annotation = { path: string; start_line: number; annotation_level: string; title: string | null; message: string };
    const annotations = out.code === 0 ? parse<Annotation[]>(out.stdout) ?? [] : [];
    return annotations
      .filter((a) => a.annotation_level === "failure" && a.path && a.start_line > 0)
      .map((a) => ({ file: a.path, line: a.start_line, check: run.name, title: a.title || null, message: a.message, url: run.html_url }));
  }));
  return perRun.flat();
}
