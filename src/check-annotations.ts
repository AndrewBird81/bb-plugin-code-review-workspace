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

/** The end of a failed run's log that's kept: its last lines, this many at most, and this many characters. */
const LOG_LINES = 200;
const LOG_CHARS = 20_000;

/** The end of a failed run's log, `gh run view --log-failed` (a read), for the reviewer to quote to the agent. PR reviews only. */
export async function readCheckLog(gh: typeof runGh, review: ReviewMeta, runId: number): Promise<{ ok: true; log: string } | { ok: false; error: string }> {
  if (review.kind !== "pr" || !review.repo) return { ok: false, error: "Only a PR’s checks have logs to read." };
  const out = await gh(["run", "view", String(runId), "--log-failed", "--repo", review.repo]);
  if (out.code !== 0) return { ok: false, error: `Couldn’t read the check’s log: ${(out.stderr || out.stdout).trim().split("\n")[0] || "gh failed"}` };
  const lines = out.stdout.trimEnd().split("\n").slice(-LOG_LINES).join("\n");
  // Cut at a line's start, so the first line kept is whole.
  const log = lines.length > LOG_CHARS ? lines.slice(lines.indexOf("\n", lines.length - LOG_CHARS) + 1) : lines;
  return log.trim() ? { ok: true, log } : { ok: false, error: "The check’s log has no failed steps to show." };
}
