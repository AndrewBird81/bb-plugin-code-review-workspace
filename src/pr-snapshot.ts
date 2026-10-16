import { ghErrorMessage, ghPrViewArgs, ghPrDiffArgs, ghPrHeadArgs, type runGh } from "./gh";

/** Read a diff only when both surrounding head checks identify the same revision. */
export async function readPrSnapshot(run: typeof runGh, number: number, repo: string, cwd?: string) {
  const view = await run(ghPrViewArgs(number, repo), { cwd });
  if (view.code !== 0) throw new Error(ghErrorMessage(view));
  let pr: { title: string; author?: { login?: string }; baseRefName: string; headRefName: string; url: string; headRefOid: string };
  try {
    pr = JSON.parse(view.stdout);
    if (!pr || typeof pr.headRefOid !== "string" || !pr.headRefOid || typeof pr.title !== "string" || typeof pr.baseRefName !== "string" || typeof pr.headRefName !== "string") throw new Error();
  } catch {
    throw new Error("Unexpected gh PR output. Couldn't identify the revision to review.");
  }
  const diff = await readPrDiff(run, number, repo, cwd);
  const head = await run(ghPrHeadArgs(number, repo), { cwd });
  if (head.code !== 0) throw new Error(ghErrorMessage(head));
  let current: unknown;
  try { current = JSON.parse(head.stdout)?.headRefOid; } catch { /* reject below */ }
  if (current !== pr.headRefOid) throw new Error("The PR changed while its diff was loading. Retry to review the latest revision.");
  if (!diff.trim()) throw new Error("No changes found for that PR.");
  return { pr, patch: diff };
}

/** GitHub won't send a diff over 20,000 lines or 300 files (HTTP 406). */
export const diffTooLarge = (r: { stdout: string; stderr: string }) => /HTTP 406|too_large|diff exceeded the maximum/i.test(r.stderr + r.stdout);

/** The PR's diff, rebuilt from its list of files when GitHub won't send one that large. */
export async function readPrDiff(run: typeof runGh, number: number, repo: string, cwd?: string): Promise<string> {
  const diff = await run(ghPrDiffArgs(number, repo), { cwd });
  if (diff.code === 0) return diff.stdout;
  if (!diffTooLarge(diff)) throw new Error(ghErrorMessage(diff));
  return readFilesPatch(run, ["api", "--paginate", `repos/${repo}/pulls/${number}/files?per_page=100`, "--jq", ".[] | @json"], cwd);
}

interface GithubFile { filename: string; previous_filename?: string; status: string; patch?: string; changes?: number; sha?: string }

/** GitHub lists at most 3,000 of a PR's files. */
const LISTED_FILES_LIMIT = 3_000;
/** Heads a patch rebuilt from a list GitHub may have cut short. */
export const FILES_CAPPED_NOTE = "GitHub listed only the first 3,000 changed files; later files aren't in this review.";

/** Read GitHub's file list (one JSON file per line) as a patch. */
export async function readFilesPatch(run: typeof runGh, args: string[], cwd?: string): Promise<string> {
  const out = await run(args, { cwd });
  if (out.code !== 0) throw new Error(ghErrorMessage(out));
  const files = out.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as GithubFile);
  // Before the first file's header, which splitPatchByFile drops, so the agents read it and the diff doesn't show it.
  return (files.length >= LISTED_FILES_LIMIT ? `${FILES_CAPPED_NOTE}\n` : "") + patchFromFiles(files);
}

/** Git C-quotes a name with `"`, `\` or control characters. */
function quoted(name: string): string {
  if (!/["\\\x00-\x1f\x7f]/.test(name)) return name;
  const escapes: Record<string, string> = { "\t": "\\t", "\n": "\\n", "\r": "\\r" };
  return `"${name.replace(/["\\]/g, "\\$&").replace(/[\x00-\x1f\x7f]/g, (c) => escapes[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`)}"`;
}

/** The line standing in for a file's hunks GitHub didn't send; its blob follows, so a changed file reads as changed. */
export const NO_DIFF = "GitHub didn't send this file's diff";

/** A git-style patch from GitHub's files, each with its hunks; a file GitHub sent no hunks for says so. */
function patchFromFiles(files: GithubFile[]): string {
  return files.map((f) => {
    const from = f.previous_filename ?? f.filename;
    const [a, b] = [quoted(`a/${from}`), quoted(`b/${f.filename}`)];
    const lines = [`diff --git ${a} ${b}`];
    if (f.status === "renamed") lines.push(`rename from ${quoted(from)}`, `rename to ${quoted(f.filename)}`);
    if (f.patch) lines.push(`--- ${f.status === "added" ? "/dev/null" : a}`, `+++ ${f.status === "removed" ? "/dev/null" : b}`, f.patch.replace(/\n$/, ""));
    // A pure rename has no diff to send.
    else if (f.status !== "renamed" || f.changes) lines.push(`${NO_DIFF}: it's too large or binary.${f.sha ? ` (blob ${f.sha.slice(0, 7)})` : ""}`);
    return lines.join("\n") + "\n";
  }).join("");
}
