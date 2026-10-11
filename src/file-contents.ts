// A changed file's whole old and new contents, so the diff can show the code around its hunks.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewMeta } from "./store";
import { ghErrorMessage, type runGh, type runGit } from "./gh";
import { patchRows, type PatchFile } from "./patch";
import { declaredGenerated } from "./classify";

export type FileContentsResult = { ok: true; old: string | null; new: string | null } | { ok: false; error: string };
/** `missing`: GitHub has no such file at that commit. */
export type Read = { text: string } | { error: string; missing?: boolean };

/** Larger files stay as the diff: pierre would draw them as plain text, and they'd fill the panel's memory. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A commit's file never changes, so a PR's reads are kept, up to this many. */
const CACHE_SIZE = 64;
const cache = new Map<string, string>();

function remember(key: string, text: string) {
  cache.delete(key);
  cache.set(key, text);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

/** Whether each side's contents hold every line the patch shows on that side, at its number. */
function matchesPatch(text: string, old: string | null, next: string | null): boolean {
  const oldLines = old?.split("\n");
  const newLines = next?.split("\n");
  return patchRows(text).every((row) => {
    if (row.kind !== "+" && row.kind !== "-" && row.kind !== " ") return true;
    const code = row.text.slice(1);
    return (row.kind === "+" || oldLines?.[row.oldLine - 1] === code) && (row.kind === "-" || newLines?.[row.newLine - 1] === code);
  });
}

const tooLarge = (path: string) => ({ error: `${path} is too large to show in full.` });

async function githubFile(gh: typeof runGh, repo: string, sha: string, path: string): Promise<Read> {
  const key = `${repo}\0${sha}\0${path}`;
  const cached = cache.get(key);
  if (cached !== undefined) return { text: cached };
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const out = await gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${encoded}?ref=${sha}`], { maxBuffer: MAX_FILE_BYTES });
  if (out.code !== 0) return /too much to read/.test(out.stderr) ? tooLarge(path) : { error: `Couldn’t read ${path}: ${ghErrorMessage(out)}`, missing: /HTTP 404|Not Found/.test(out.stderr + out.stdout) };
  remember(key, out.stdout);
  return { text: out.stdout };
}

/** The commit a PR's diff starts from: where its head left the base branch. */
async function mergeBase(gh: typeof runGh, review: ReviewMeta, head: string): Promise<Read> {
  const key = `${review.repo}\0${review.base}...${head}`;
  const cached = cache.get(key);
  if (cached !== undefined) return { text: cached };
  const out = await gh(["api", `repos/${review.repo}/compare/${encodeURIComponent(review.base!)}...${head}`, "--jq", ".merge_base_commit.sha"]);
  const sha = out.stdout.trim();
  if (out.code !== 0 || !sha) return { error: `Couldn’t find the PR’s base commit: ${ghErrorMessage(out)}` };
  remember(key, sha);
  return { text: sha };
}

export async function gitFile(git: typeof runGit, cwd: string, rev: string, path: string): Promise<Read> {
  const out = await git(["show", "--no-textconv", `${rev}:${path}`], { cwd, maxBuffer: MAX_FILE_BYTES });
  if (out.code !== 0) return /too much to read/.test(out.stderr) ? tooLarge(path) : { error: `Couldn’t read ${path} at ${rev}: ${out.stderr.trim() || "not found"}` };
  return { text: out.stdout };
}

export async function workingTreeFile(cwd: string, path: string): Promise<Read> {
  try {
    if ((await stat(join(cwd, path))).size > MAX_FILE_BYTES) return tooLarge(path);
    return { text: await readFile(join(cwd, path), "utf8") };
  } catch {
    return { error: `Couldn’t read ${path} in ${cwd}.` };
  }
}

/** Where a local review's diff starts and ends: `a...b` from their merge base, `a..b` from a, and a single ref against the working tree (null). */
export async function localRevs(git: typeof runGit, review: ReviewMeta): Promise<{ from: string; to: string | null } | { error: string }> {
  const [, from, dots, to] = review.gitRef!.match(/^(.*?)(\.\.\.?)(.*)$/) ?? [];
  if (!dots) return { from: review.gitRef!, to: null };
  if (dots === "..") return { from: from || "HEAD", to: to || "HEAD" };
  const base = await git(["merge-base", from || "HEAD", to || "HEAD"], { cwd: review.cwd });
  if (base.code !== 0) return { error: `Couldn’t find where ${review.gitRef} starts: ${base.stderr.trim()}` };
  return { from: base.stdout.trim(), to: to || "HEAD" };
}

/** A changed file's old and new contents (null for a side it doesn't exist on), when they agree with its diff. */
export async function readFileContents(gh: { runGh: typeof runGh; runGit: typeof runGit }, review: ReviewMeta, file: PatchFile): Promise<FileContentsResult> {
  const rows = patchRows(file.text);
  if (rows.some((row) => row.kind === "header" && /^(Binary files |GIT binary patch)/.test(row.text))) return { ok: false, error: "A binary file shows as the diff only." };
  // A repo-relative path only: no "." or ".." segments that could reach another endpoint or directory.
  const unsafe = (path: string) => path.startsWith("/") || path.split("/").some((segment) => !segment || segment === "." || segment === "..");
  const oldPath = file.oldPath ?? file.path;
  if (unsafe(file.path) || unsafe(oldPath)) return { ok: false, error: `${file.path} isn’t a repo-relative file path.` };
  const added = rows.some((row) => row.kind === "header" && (row.text.startsWith("new file mode") || row.text === "--- /dev/null"));
  const deleted = rows.some((row) => row.kind === "header" && (row.text.startsWith("deleted file mode") || row.text === "+++ /dev/null"));

  let readOld: () => Promise<Read>;
  let readNew: () => Promise<Read>;
  if (review.kind === "pr") {
    const { repo, base, headSha } = review;
    if (!repo || !base || !headSha) return { ok: false, error: "This review has no commits to read the file at." };
    readOld = async () => {
      const sha = await mergeBase(gh.runGh, review, headSha);
      return "error" in sha ? sha : githubFile(gh.runGh, repo, sha.text, oldPath);
    };
    readNew = () => githubFile(gh.runGh, repo, headSha, file.path);
  } else {
    const { cwd } = review;
    if (!cwd || !review.gitRef) return { ok: false, error: "This review has no checkout to read the file from." };
    const revs = await localRevs(gh.runGit, review);
    if ("error" in revs) return { ok: false, error: revs.error };
    readOld = () => gitFile(gh.runGit, cwd, revs.from, oldPath);
    readNew = () => revs.to === null ? workingTreeFile(cwd, file.path) : gitFile(gh.runGit, cwd, revs.to, file.path);
  }
  const none: Read = { text: "" };
  const [old, next] = await Promise.all([added ? none : readOld(), deleted ? none : readNew()]);
  if ("error" in old) return { ok: false, error: old.error };
  if ("error" in next) return { ok: false, error: next.error };
  const contents = { old: added ? null : old.text, new: deleted ? null : next.text };
  if (!matchesPatch(file.text, contents.old, contents.new)) return { ok: false, error: "The file doesn’t match the diff, so only the diff shows." };
  return { ok: true, ...contents };
}

/** Generated or not, by the repo's .gitattributes at a PR's head: kept per commit. */
const generatedCache = new Map<string, string>();

/** The changed files the repo's root .gitattributes, at the diff's new side, marks generated or vendored. */
export async function readGeneratedFiles(gh: { runGh: typeof runGh; runGit: typeof runGit }, review: ReviewMeta, paths: string[]): Promise<string[]> {
  let attributes: Read;
  if (review.kind === "pr") {
    if (!review.repo || !review.headSha) return [];
    const key = `${review.repo}\0${review.headSha}`;
    if (!generatedCache.has(key)) {
      // A repo without the file has nothing to declare; another failure is worth trying again.
      const read = await githubFile(gh.runGh, review.repo, review.headSha, ".gitattributes");
      if ("error" in read && !read.missing) return [];
      generatedCache.set(key, "text" in read ? read.text : "");
      if (generatedCache.size > CACHE_SIZE) generatedCache.delete(generatedCache.keys().next().value!);
    }
    attributes = { text: generatedCache.get(key)! };
  } else {
    if (!review.cwd || !review.gitRef) return [];
    const revs = await localRevs(gh.runGit, review);
    if ("error" in revs) return [];
    attributes = revs.to === null ? await workingTreeFile(review.cwd, ".gitattributes") : await gitFile(gh.runGit, review.cwd, revs.to, ".gitattributes");
  }
  return "text" in attributes ? declaredGenerated(attributes.text, paths) : [];
}
