// Who owns each changed file, by the repo's CODEOWNERS at the diff's new side, matched as GitHub does.
import type { ReviewMeta } from "./store";
import { ghErrorMessage, type runGh, type runGit } from "./gh";
import { gitFile, localRevs, workingTreeFile, type Read } from "./file-contents";

/** Where GitHub looks for CODEOWNERS, in order; the first one found is the one used. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

export interface OwnerRule { pattern: RegExp; owners: string[] }
export interface FileOwners { file: string; owners: string[]; mine: boolean }

/**
 * A CODEOWNERS pattern as a regular expression over repo-relative paths: gitignore's rules as GitHub
 * documents them. A leading or inner "/" anchors it at the root; a trailing "/" matches what's under
 * a directory; otherwise it matches a file, or a directory and what's under it, at any depth. "docs/*"
 * matches only docs' own files. Null for what GitHub doesn't support: "!" and "[ ]".
 */
export function ownerPattern(pattern: string): RegExp | null {
  if (!pattern || pattern.startsWith("!") || /[[\]]/.test(pattern)) return null;
  const directory = pattern.endsWith("/");
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const anchored = pattern.startsWith("/") || trimmed.includes("/");
  const segments = trimmed.split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      // Any number of directories: leading, inner, or (last) everything below.
      source += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    source += segment.replace(/[.+^$(){}|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + (last ? "" : "/");
  });
  const prefix = anchored ? "^" : "^(?:[^/]+/)*";
  const suffix = directory ? "/.*$" : segments.at(-1) === "*" || segments.at(-1) === "**" ? "$" : "(?:/.*)?$";
  return new RegExp(prefix + source + suffix);
}

/** The rules of a CODEOWNERS file, in order. Comments, blank lines, and patterns GitHub skips are left out. */
export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Whitespace separates the pattern from its owners, unless escaped; "\#" is a literal #.
    const tokens = line.match(/(?:\\.|[^\s\\])+/g) ?? [];
    const [first, ...rest] = tokens;
    if (!first) continue;
    const owners: string[] = [];
    for (const token of rest) {
      if (token.startsWith("#")) break;
      owners.push(token);
    }
    const pattern = ownerPattern(first.replace(/\\(.)/g, "$1"));
    if (pattern) rules.push({ pattern, owners });
  }
  return rules;
}

/** A file's owners: the last rule that matches wins, and one without owners leaves the file unowned. */
export function ownersOf(rules: readonly OwnerRule[], path: string): string[] {
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i].pattern.test(path)) return rules[i].owners;
  return [];
}

/** Whether you own a file: as @login, or through a team you're on ("org/slug", lowercase, as the viewer reads them). */
export function ownedBy(owners: readonly string[], login: string | null, teams: ReadonlySet<string>): boolean {
  const me = login ? `@${login.toLowerCase()}` : null;
  return owners.some((owner) => {
    const name = owner.toLowerCase();
    return name === me || (name.startsWith("@") && name.includes("/") && teams.has(name.slice(1)));
  });
}

const QUERY = `query($owner:String!,$repo:String!,$a:String!,$b:String!,$c:String!){repository(owner:$owner,name:$repo){
  a:object(expression:$a){...on Blob{text}} b:object(expression:$b){...on Blob{text}} c:object(expression:$c){...on Blob{text}}}}`;

/** A commit's CODEOWNERS never changes, so a PR's reads are kept per head: the text, or "" without one. */
const cache = new Map<string, string>();
const CACHE_SIZE = 64;

/** The repo's CODEOWNERS at the diff's new side: "" when it has none. A PR reads all three places in one GraphQL call. */
export async function readCodeowners(gh: { runGh: typeof runGh; runGit: typeof runGit }, review: ReviewMeta): Promise<Read> {
  if (review.kind === "pr") {
    if (!review.repo || !review.headSha) return { text: "" };
    const key = `${review.repo}\0${review.headSha}`;
    const cached = cache.get(key);
    if (cached !== undefined) return { text: cached };
    const [owner, name] = review.repo.split("/");
    const [a, b, c] = CODEOWNERS_PATHS.map((path) => `${review.headSha}:${path}`);
    const out = await gh.runGh(["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-f", `a=${a}`, "-f", `b=${b}`, "-f", `c=${c}`]);
    let repository: Record<string, { text?: string } | null> | undefined;
    try { repository = JSON.parse(out.stdout)?.data?.repository; } catch { repository = undefined; }
    if (out.code !== 0 || !repository) return { error: `Couldn’t read CODEOWNERS: ${ghErrorMessage(out)}` };
    const text = [repository.a, repository.b, repository.c].find((blob) => typeof blob?.text === "string")?.text ?? "";
    cache.set(key, text);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return { text };
  }
  if (!review.cwd || !review.gitRef) return { text: "" };
  const revs = await localRevs(gh.runGit, review);
  if ("error" in revs) return revs;
  for (const path of CODEOWNERS_PATHS) {
    const read = revs.to === null ? await workingTreeFile(review.cwd, path) : await gitFile(gh.runGit, review.cwd, revs.to, path);
    if ("text" in read) return read;
  }
  return { text: "" };
}

/** Each changed file with owners, and whether you or a team you're on is one of them. */
export async function codeOwners(
  gh: { runGh: typeof runGh; runGit: typeof runGit },
  review: ReviewMeta,
  paths: readonly string[],
  viewer: () => Promise<{ login: string | null; teams: ReadonlySet<string> }>,
): Promise<FileOwners[]> {
  const read = await readCodeowners(gh, review);
  if ("error" in read) throw new Error(read.error);
  const rules = parseCodeowners(read.text);
  const owned = paths.map((file) => ({ file, owners: ownersOf(rules, file) })).filter((entry) => entry.owners.length);
  if (!owned.length) return [];
  const { login, teams } = await viewer();
  return owned.map((entry) => ({ ...entry, mine: ownedBy(entry.owners, login, teams) }));
}

/** read_pr_context's line on what the reviewer owns, or null without CODEOWNERS owners. */
export function describeOwnership(files: readonly FileOwners[]): string | null {
  if (!files.length) return null;
  const mine = files.filter((entry) => entry.mine).map((entry) => entry.file);
  if (!mine.length) return `CODEOWNERS: the reviewer owns none of the changed files, directly or through a team.`;
  const listed = mine.slice(0, 50).join(", ");
  return `CODEOWNERS: the reviewer owns ${mine.length} of the changed files, directly or through a team: ${listed}${mine.length > 50 ? ", …" : ""}. Look hardest at those.`;
}
